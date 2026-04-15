use crate::models::{ChatContent, ChatContentPart, ChatMessage};
use crate::settings::GenerationRequestConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, watch, Mutex, OnceCell};

const WORKER_READY_TIMEOUT: Duration = Duration::from_secs(120);
const WORKER_CANCEL_TIMEOUT: Duration = Duration::from_secs(3);
const WORKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

fn worker_profile_output_path() -> PathBuf {
    std::env::temp_dir().join("friday-python-worker-%p.profraw")
}

#[derive(Debug)]
pub enum StreamEvent {
    Token(String),
    Thought(String),
    Error(String),
    Done,
    ToolCall {
        name: String,
        args: serde_json::Value,
    },
    ToolResult {
        name: String,
        result: serde_json::Value,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkerEngineConfig {
    model_path: PathBuf,
    max_num_tokens: u32,
    backend: String,
}

#[derive(Debug)]
pub(crate) struct PythonWorkerSpawnConfig<'a> {
    pub python_binary: &'a Path,
    pub worker_script: &'a Path,
    pub model_path: &'a Path,
    pub max_num_tokens: u32,
    pub backend: &'a str,
    pub web_search_base_url: Option<&'a str>,
    pub python_site_packages: &'a Path,
    pub python_runtime_lib_dir: &'a Path,
}

#[derive(Debug)]
struct ActiveRequest {
    request_id: String,
    sender: mpsc::Sender<StreamEvent>,
    done_tx: watch::Sender<bool>,
}

#[derive(Debug, Default)]
struct WorkerState {
    warm_waiter: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
    active_request: Option<ActiveRequest>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WorkerCommand {
    Warm {
        model_path: String,
        max_num_tokens: u32,
        backend: String,
    },
    Chat {
        request_id: String,
        model_path: String,
        max_num_tokens: u32,
        generation_config: WorkerGenerationConfig,
        tool_permissions: WorkerToolPermissions,
        messages: Vec<WorkerMessage>,
    },
    Cancel {
        request_id: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct WorkerGenerationConfig {
    thinking_enabled: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
struct WorkerToolPermissions {
    web: bool,
    local_files: bool,
    calculate: bool,
    current_datetime: bool,
}

impl WorkerToolPermissions {
    fn for_chat(web_enabled: bool) -> Self {
        Self {
            web: web_enabled,
            local_files: false,
            calculate: web_enabled,
            current_datetime: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct WorkerMessage {
    role: String,
    content: WorkerMessageContent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
enum WorkerMessageContent {
    Text(String),
    Parts(Vec<WorkerContentPart>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
enum WorkerContentPart {
    Text { text: String },
    Image { blob: String },
    Audio { path: String },
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WorkerEvent {
    Ready {
        model_path: String,
        max_num_tokens: u32,
    },
    Token {
        request_id: String,
        text: String,
    },
    Thought {
        request_id: String,
        text: String,
    },
    ToolCall {
        request_id: String,
        name: String,
        args: Value,
    },
    ToolResult {
        request_id: String,
        name: String,
        result: Value,
    },
    Error {
        request_id: Option<String>,
        message: String,
    },
    Done {
        request_id: String,
    },
}

pub struct PythonWorkerClient {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<BufWriter<ChildStdin>>>,
    state: Arc<Mutex<WorkerState>>,
    ready: OnceCell<()>,
    config: WorkerEngineConfig,
}

impl PythonWorkerClient {
    pub async fn spawn(config: PythonWorkerSpawnConfig<'_>) -> Result<Self, String> {
        let PythonWorkerSpawnConfig {
            python_binary,
            worker_script,
            model_path,
            max_num_tokens,
            backend,
            web_search_base_url,
            python_site_packages,
            python_runtime_lib_dir,
        } = config;

        let mut command = Command::new(python_binary);
        command
            .arg(worker_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("LLVM_PROFILE_FILE", worker_profile_output_path())
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONPATH", python_site_packages)
            .env(
                "DYLD_LIBRARY_PATH",
                format!(
                    "{}:{}",
                    python_site_packages.join("litert_lm").display(),
                    python_runtime_lib_dir.display()
                ),
            );
        if let Some(web_search_base_url) = web_search_base_url {
            command.env("FRIDAY_SEARXNG_BASE_URL", web_search_base_url);
        }

        let mut child = command.spawn().map_err(|error| {
            format!(
                "Failed to start Friday LiteRT Python worker {}: {}",
                python_binary.display(),
                error
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture Python worker stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture Python worker stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture Python worker stderr".to_string())?;

        let client = Self {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(BufWriter::new(stdin))),
            state: Arc::new(Mutex::new(WorkerState::default())),
            ready: OnceCell::new(),
            config: WorkerEngineConfig {
                model_path: model_path.to_path_buf(),
                max_num_tokens,
                backend: backend.to_string(),
            },
        };

        client.spawn_stdout_reader(stdout);
        client.spawn_stderr_reader(stderr);
        client.send_warm().await?;
        Ok(client)
    }

    pub fn matches(&self, model_path: &Path, max_num_tokens: u32, backend: &str) -> bool {
        self.config.model_path == model_path
            && self.config.max_num_tokens == max_num_tokens
            && self.config.backend == backend
    }

    pub async fn send_chat_with_options(
        &self,
        messages: &[ChatMessage],
        generation_config: GenerationRequestConfig,
        tools_enabled: bool,
    ) -> Result<mpsc::Receiver<StreamEvent>, String> {
        self.ready
            .get_or_try_init(|| async { Ok::<(), String>(()) })
            .await?;

        let normalized_messages = normalize_messages_for_worker(messages)?;
        let _ = split_preface_and_prompt(&normalized_messages)?;

        let request_id = uuid::Uuid::new_v4().to_string();
        let worker_generation_config = WorkerGenerationConfig {
            thinking_enabled: generation_config.thinking_enabled.unwrap_or(false),
        };
        let (tx, rx) = mpsc::channel(128);
        let (done_tx, _done_rx) = watch::channel(false);

        {
            let mut state = self.state.lock().await;
            if state.active_request.is_some() {
                return Err("Friday's LiteRT worker is already handling another request.".into());
            }

            state.active_request = Some(ActiveRequest {
                request_id: request_id.clone(),
                sender: tx,
                done_tx,
            });
        }

        if let Err(error) = self
            .send_command(&WorkerCommand::Chat {
                request_id: request_id.clone(),
                model_path: self.config.model_path.display().to_string(),
                max_num_tokens: self.config.max_num_tokens,
                generation_config: worker_generation_config,
                tool_permissions: WorkerToolPermissions::for_chat(tools_enabled),
                messages: normalized_messages,
            })
            .await
        {
            self.finish_active_request(Some(StreamEvent::Error(error.clone())))
                .await;
            return Err(error);
        }

        Ok(rx)
    }

    pub async fn cancel_active_request(&self) -> Result<(), String> {
        let (request_id, mut done_rx) = {
            let state = self.state.lock().await;
            let Some(active_request) = state.active_request.as_ref() else {
                return Ok(());
            };
            (
                active_request.request_id.clone(),
                active_request.done_tx.subscribe(),
            )
        };

        self.send_command(&WorkerCommand::Cancel {
            request_id: request_id.clone(),
        })
        .await?;

        let wait_result = tokio::time::timeout(WORKER_CANCEL_TIMEOUT, async move {
            while !*done_rx.borrow() {
                if done_rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;

        if wait_result.is_err() {
            let error = format!(
                "Python worker did not stop request {} in time; killing worker.",
                request_id
            );
            tracing::warn!("{}", error);
            self.kill().await?;
        }

        Ok(())
    }

    pub async fn send_shutdown(&self) -> Result<(), String> {
        let _ = self.send_command(&WorkerCommand::Shutdown).await;

        let shutdown = tokio::time::timeout(WORKER_SHUTDOWN_TIMEOUT, async {
            loop {
                {
                    let mut child = self.child.lock().await;
                    if child
                        .try_wait()
                        .map_err(|error| format!("Failed to poll Python worker: {}", error))?
                        .is_some()
                    {
                        return Ok::<(), String>(());
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;

        match shutdown {
            Ok(result) => result,
            Err(_) => self.kill().await,
        }
    }

    pub async fn is_alive(&self) -> bool {
        let mut child = self.child.lock().await;
        child.try_wait().ok().flatten().is_none()
    }

    pub async fn kill(&self) -> Result<(), String> {
        self.finish_active_request(Some(StreamEvent::Error(
            "Friday's LiteRT worker stopped unexpectedly.".to_string(),
        )))
        .await;

        let mut child = self.child.lock().await;
        if child.try_wait().ok().flatten().is_some() {
            return Ok(());
        }
        child
            .kill()
            .await
            .map_err(|error| format!("Failed to kill Friday LiteRT Python worker: {}", error))
    }

    async fn send_warm(&self) -> Result<(), String> {
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        {
            let mut state = self.state.lock().await;
            state.warm_waiter = Some(ready_tx);
        }

        self.send_command(&WorkerCommand::Warm {
            model_path: self.config.model_path.display().to_string(),
            max_num_tokens: self.config.max_num_tokens,
            backend: self.config.backend.clone(),
        })
        .await?;

        let ready_result = tokio::time::timeout(WORKER_READY_TIMEOUT, ready_rx)
            .await
            .map_err(|_| "Python worker did not become ready in time.".to_string())?
            .map_err(|_| "Python worker warm-up channel closed unexpectedly.".to_string())?;

        match ready_result {
            Ok(()) => {
                let _ = self.ready.set(());
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    async fn send_command(&self, command: &WorkerCommand) -> Result<(), String> {
        let encoded = serde_json::to_string(command)
            .map_err(|error| format!("Failed to encode Python worker command: {}", error))?;
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(encoded.as_bytes())
            .await
            .map_err(|error| format!("Failed to write Python worker command: {}", error))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("Failed to finalize Python worker command: {}", error))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Failed to flush Python worker command: {}", error))
    }

    fn spawn_stdout_reader(&self, stdout: ChildStdout) {
        let state = self.state.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }

                match parse_worker_event_line(&line) {
                    Ok(event) => dispatch_worker_event(&state, event).await,
                    Err(error) => {
                        tracing::warn!("Invalid Python worker event: {}", error);
                        finish_active_request_locked(
                            &state,
                            Some(StreamEvent::Error(error)),
                            Some("Python worker stream ended with invalid data."),
                        )
                        .await;
                    }
                }
            }

            finish_active_request_locked(
                &state,
                Some(StreamEvent::Error(
                    "Friday's LiteRT worker stream closed.".to_string(),
                )),
                Some("Python worker stream closed before completion."),
            )
            .await;
        });
    }

    fn spawn_stderr_reader(&self, stderr: tokio::process::ChildStderr) {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    tracing::warn!("Friday LiteRT Python worker: {}", line);
                }
            }
        });
    }

    async fn finish_active_request(&self, event: Option<StreamEvent>) {
        finish_active_request_locked(&self.state, event, None).await;
    }
}

impl Drop for PythonWorkerClient {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}

async fn dispatch_worker_event(state: &Mutex<WorkerState>, event: WorkerEvent) {
    match event {
        WorkerEvent::Ready { .. } => {
            let mut guard = state.lock().await;
            if let Some(waiter) = guard.warm_waiter.take() {
                let _ = waiter.send(Ok(()));
            }
        }
        WorkerEvent::Token { request_id, text } => {
            send_if_active(state, &request_id, StreamEvent::Token(text)).await;
        }
        WorkerEvent::Thought { request_id, text } => {
            send_if_active(state, &request_id, StreamEvent::Thought(text)).await;
        }
        WorkerEvent::ToolCall {
            request_id,
            name,
            args,
        } => {
            send_if_active(state, &request_id, StreamEvent::ToolCall { name, args }).await;
        }
        WorkerEvent::ToolResult {
            request_id,
            name,
            result,
        } => {
            send_if_active(state, &request_id, StreamEvent::ToolResult { name, result }).await;
        }
        WorkerEvent::Done { request_id } => {
            finish_request_by_id(state, &request_id, Some(StreamEvent::Done)).await;
        }
        WorkerEvent::Error {
            request_id,
            message,
        } => {
            if let Some(request_id) = request_id {
                finish_request_by_id(state, &request_id, Some(StreamEvent::Error(message))).await;
                return;
            }

            let mut guard = state.lock().await;
            if let Some(waiter) = guard.warm_waiter.take() {
                let _ = waiter.send(Err(message.clone()));
                return;
            }

            drop(guard);
            finish_active_request_locked(state, Some(StreamEvent::Error(message)), None).await;
        }
    }
}

async fn send_if_active(state: &Mutex<WorkerState>, request_id: &str, event: StreamEvent) {
    let sender = {
        let guard = state.lock().await;
        guard
            .active_request
            .as_ref()
            .filter(|active| active.request_id == request_id)
            .map(|active| active.sender.clone())
    };

    if let Some(sender) = sender {
        let _ = sender.send(event).await;
    }
}

async fn finish_request_by_id(
    state: &Mutex<WorkerState>,
    request_id: &str,
    event: Option<StreamEvent>,
) {
    let (sender, done_tx) = {
        let mut guard = state.lock().await;
        match guard.active_request.take() {
            Some(active) if active.request_id == request_id => {
                if let Some(waiter) = guard.warm_waiter.take() {
                    let _ = waiter.send(Ok(()));
                }
                (Some(active.sender), Some(active.done_tx))
            }
            Some(active) => {
                guard.active_request = Some(active);
                return;
            }
            None => return,
        }
    };

    if let Some(event) = event {
        if let Some(sender) = sender {
            let _ = sender.send(event).await;
        }
    }

    if let Some(done_tx) = done_tx {
        let _ = done_tx.send(true);
    }
}

async fn finish_active_request_locked(
    state: &Mutex<WorkerState>,
    event: Option<StreamEvent>,
    warm_error: Option<&str>,
) {
    let (warm_waiter, sender, done_tx) = {
        let mut guard = state.lock().await;
        let warm_waiter = guard.warm_waiter.take();
        let active_request = guard.active_request.take();
        let (sender, done_tx) = match active_request {
            Some(active) => (Some(active.sender), Some(active.done_tx)),
            None => (None, None),
        };
        (warm_waiter, sender, done_tx)
    };

    if let Some(waiter) = warm_waiter {
        let _ = waiter.send(Err(warm_error
            .unwrap_or("Python worker failed before warm-up completed.")
            .to_string()));
    }

    if let Some(event) = event {
        if let Some(sender) = sender {
            let _ = sender.send(event).await;
        }
    }

    if let Some(done_tx) = done_tx {
        let _ = done_tx.send(true);
    }
}

fn normalize_messages_for_worker(messages: &[ChatMessage]) -> Result<Vec<WorkerMessage>, String> {
    messages.iter().map(normalize_message_for_worker).collect()
}

fn normalize_message_for_worker(message: &ChatMessage) -> Result<WorkerMessage, String> {
    let content = match &message.content {
        ChatContent::Text(text) => WorkerMessageContent::Text(text.clone()),
        ChatContent::Parts(parts) => WorkerMessageContent::Parts(
            parts
                .iter()
                .map(normalize_content_part_for_worker)
                .collect::<Result<Vec<_>, _>>()?,
        ),
    };

    Ok(WorkerMessage {
        role: message.role.clone(),
        content,
    })
}

fn normalize_content_part_for_worker(part: &ChatContentPart) -> Result<WorkerContentPart, String> {
    match part {
        ChatContentPart::Text { text } => Ok(WorkerContentPart::Text { text: text.clone() }),
        ChatContentPart::Image { blob } => Ok(WorkerContentPart::Image {
            blob: strip_image_data_url_prefix(blob)?,
        }),
        ChatContentPart::Audio { path } => Ok(WorkerContentPart::Audio { path: path.clone() }),
    }
}

fn split_preface_and_prompt(
    messages: &[WorkerMessage],
) -> Result<(Vec<WorkerMessage>, WorkerMessage), String> {
    let prompt = messages
        .last()
        .cloned()
        .ok_or_else(|| "Chat request requires at least one message.".to_string())?;
    if prompt.role != "user" {
        return Err("The final chat message must be authored by the user.".to_string());
    }

    Ok((messages[..messages.len() - 1].to_vec(), prompt))
}

fn strip_image_data_url_prefix(blob: &str) -> Result<String, String> {
    let trimmed = blob.trim();
    if trimmed.is_empty() {
        return Err("Image attachment payload is empty.".to_string());
    }

    if let Some(remainder) = trimmed.strip_prefix("data:") {
        let (_, base64) = remainder
            .split_once(";base64,")
            .ok_or_else(|| "Image attachment data URL is missing a base64 payload.".to_string())?;
        if base64.trim().is_empty() {
            return Err("Image attachment data URL is missing image bytes.".to_string());
        }
        return Ok(base64.trim().to_string());
    }

    Ok(trimmed.to_string())
}

fn parse_worker_event_line(line: &str) -> Result<WorkerEvent, String> {
    serde_json::from_str::<WorkerEvent>(line)
        .map_err(|error| format!("Failed to parse Python worker event '{}': {}", line, error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_data_urls_are_stripped_to_raw_base64() {
        let normalized = normalize_content_part_for_worker(&ChatContentPart::Image {
            blob: "data:image/png;base64,ZmFrZQ==".to_string(),
        })
        .expect("normalized image");

        assert_eq!(
            normalized,
            WorkerContentPart::Image {
                blob: "ZmFrZQ==".to_string()
            }
        );
    }

    #[test]
    fn audio_paths_pass_through_unchanged() {
        let normalized = normalize_content_part_for_worker(&ChatContentPart::Audio {
            path: "/tmp/test-audio.wav".to_string(),
        })
        .expect("normalized audio");

        assert_eq!(
            normalized,
            WorkerContentPart::Audio {
                path: "/tmp/test-audio.wav".to_string()
            }
        );
    }

    #[test]
    fn history_split_uses_last_user_turn_as_prompt() {
        let messages = vec![
            WorkerMessage {
                role: "system".to_string(),
                content: WorkerMessageContent::Text("You are helpful.".to_string()),
            },
            WorkerMessage {
                role: "assistant".to_string(),
                content: WorkerMessageContent::Text("Hello".to_string()),
            },
            WorkerMessage {
                role: "user".to_string(),
                content: WorkerMessageContent::Text("Describe this image.".to_string()),
            },
        ];

        let (preface, prompt) = split_preface_and_prompt(&messages).expect("split messages");
        assert_eq!(preface.len(), 2);
        assert_eq!(prompt.role, "user");
    }

    #[test]
    fn chat_tool_permissions_always_include_current_datetime() {
        assert_eq!(
            WorkerToolPermissions::for_chat(false),
            WorkerToolPermissions {
                web: false,
                local_files: false,
                calculate: false,
                current_datetime: true,
            }
        );
        assert_eq!(
            WorkerToolPermissions::for_chat(true),
            WorkerToolPermissions {
                web: true,
                local_files: false,
                calculate: true,
                current_datetime: true,
            }
        );
    }

    #[test]
    fn worker_event_parser_handles_token_thought_done_and_error_lines() {
        assert_eq!(
            parse_worker_event_line(r#"{"type":"token","request_id":"req","text":"Hello"}"#)
                .expect("token event"),
            WorkerEvent::Token {
                request_id: "req".to_string(),
                text: "Hello".to_string()
            }
        );
        assert_eq!(
            parse_worker_event_line(r#"{"type":"thought","request_id":"req","text":"Plan"}"#)
                .expect("thought event"),
            WorkerEvent::Thought {
                request_id: "req".to_string(),
                text: "Plan".to_string()
            }
        );
        assert_eq!(
            parse_worker_event_line(r#"{"type":"done","request_id":"req"}"#).expect("done event"),
            WorkerEvent::Done {
                request_id: "req".to_string()
            }
        );
        assert_eq!(
            parse_worker_event_line(r#"{"type":"error","request_id":"req","message":"boom"}"#)
                .expect("error event"),
            WorkerEvent::Error {
                request_id: Some("req".to_string()),
                message: "boom".to_string()
            }
        );
    }

    #[test]
    fn worker_event_parser_handles_tool_call_and_result_lines() {
        assert_eq!(
            parse_worker_event_line(
                r#"{"type":"tool_call","request_id":"req","name":"web_search","args":{"query":"today"}}"#
            )
            .expect("tool call event"),
            WorkerEvent::ToolCall {
                request_id: "req".to_string(),
                name: "web_search".to_string(),
                args: serde_json::json!({"query":"today"}),
            }
        );
        assert_eq!(
            parse_worker_event_line(
                r#"{"type":"tool_result","request_id":"req","name":"calculate","result":{"result":"4"}}"#
            )
            .expect("tool result event"),
            WorkerEvent::ToolResult {
                request_id: "req".to_string(),
                name: "calculate".to_string(),
                result: serde_json::json!({"result":"4"}),
            }
        );
    }

    #[test]
    fn worker_profile_output_uses_a_writable_temp_path() {
        let path = worker_profile_output_path();
        let path_text = path.to_string_lossy();

        assert!(path.starts_with(std::env::temp_dir()));
        assert!(path_text.contains("friday-python-worker-%p.profraw"));
    }

}
