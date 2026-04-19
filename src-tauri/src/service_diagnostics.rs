use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::Serialize;
use std::sync::Mutex;

const FAILURE_BACKOFF_THRESHOLD: u32 = 3;
const FAILURE_BACKOFF_MINUTES: i64 = 5;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceName {
    Sidecar,
    Searxng,
    Knowledge,
}

impl ServiceName {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Sidecar => "sidecar",
            Self::Searxng => "searxng",
            Self::Knowledge => "knowledge",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDiagnostics {
    pub service: String,
    pub state: String,
    pub last_failure_at: Option<String>,
    pub last_failure_stage: Option<String>,
    pub message: String,
    pub consecutive_failures: u32,
    pub next_retry_at: Option<String>,
    pub log_tail: Option<String>,
}

impl ServiceDiagnostics {
    pub fn unavailable(service: ServiceName, message: impl Into<String>) -> Self {
        Self {
            service: service.as_str().to_string(),
            state: "unavailable".to_string(),
            last_failure_at: None,
            last_failure_stage: None,
            message: message.into(),
            consecutive_failures: 0,
            next_retry_at: None,
            log_tail: None,
        }
    }
}

#[derive(Debug)]
pub struct DiagnosticsTracker {
    diagnostics: Mutex<ServiceDiagnostics>,
}

impl DiagnosticsTracker {
    pub fn new(service: ServiceName, unavailable_message: impl Into<String>) -> Self {
        Self {
            diagnostics: Mutex::new(ServiceDiagnostics::unavailable(
                service,
                unavailable_message,
            )),
        }
    }

    pub fn current(&self) -> ServiceDiagnostics {
        self.diagnostics.lock().unwrap().clone()
    }

    pub fn mark_ready(&self, message: impl Into<String>) {
        let mut diagnostics = self.diagnostics.lock().unwrap();
        diagnostics.state = "ready".to_string();
        diagnostics.message = message.into();
        diagnostics.consecutive_failures = 0;
        diagnostics.last_failure_at = None;
        diagnostics.last_failure_stage = None;
        diagnostics.next_retry_at = None;
        diagnostics.log_tail = None;
    }

    pub fn mark_unavailable(&self, message: impl Into<String>) {
        let mut diagnostics = self.diagnostics.lock().unwrap();
        diagnostics.state = "unavailable".to_string();
        diagnostics.message = message.into();
        diagnostics.consecutive_failures = 0;
        diagnostics.last_failure_at = None;
        diagnostics.last_failure_stage = None;
        diagnostics.next_retry_at = None;
        diagnostics.log_tail = None;
    }

    pub fn record_failure(
        &self,
        stage: impl Into<String>,
        message: impl Into<String>,
        log_tail: Option<String>,
    ) -> ServiceDiagnostics {
        let mut diagnostics = self.diagnostics.lock().unwrap();
        let now = Utc::now();
        diagnostics.consecutive_failures += 1;
        diagnostics.last_failure_at = Some(now.to_rfc3339());
        diagnostics.last_failure_stage = Some(stage.into());
        diagnostics.message = message.into();
        diagnostics.log_tail = log_tail;

        if diagnostics.consecutive_failures >= FAILURE_BACKOFF_THRESHOLD {
            diagnostics.state = "backoff".to_string();
            diagnostics.next_retry_at =
                Some((now + ChronoDuration::minutes(FAILURE_BACKOFF_MINUTES)).to_rfc3339());
        } else {
            diagnostics.state = "degraded".to_string();
            diagnostics.next_retry_at = None;
        }

        diagnostics.clone()
    }

    pub fn can_attempt(&self, manual_retry: bool) -> Result<(), String> {
        let diagnostics = self.diagnostics.lock().unwrap();
        if manual_retry {
            return Ok(());
        }

        if diagnostics.state != "backoff" {
            return Ok(());
        }

        let Some(next_retry_at) = diagnostics.next_retry_at.as_deref() else {
            return Ok(());
        };
        let next_retry_at = DateTime::parse_from_rfc3339(next_retry_at)
            .map_err(|error| format!("Invalid retry timestamp: {}", error))?
            .with_timezone(&Utc);

        if Utc::now() >= next_retry_at {
            Ok(())
        } else {
            Err(format!(
                "{} is temporarily backed off until {}.",
                diagnostics.service,
                next_retry_at.to_rfc3339()
            ))
        }
    }
}
