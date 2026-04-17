use crate::models::python_worker::{PythonWorkerClient, PythonWorkerSpawnConfig, StreamEvent};
use crate::models::ChatMessage;
use crate::python_runtime::{
    bundled_resource_source_path, ensure_embedded_python_runtime, install_python_wheel,
    sha256_file_hex, sync_file_if_changed,
};
use crate::runtime_manifest::{
    embedded_runtime_manifest, PlatformRuntimeSpec, RuntimeManifest, RuntimeModelSpec,
    RuntimePolicy,
};
use crate::settings::GenerationRequestConfig;
use crate::{persist_active_model_id, AppState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sysinfo::{ProcessesToUpdate, System};
use tauri::Emitter;
use tauri::State;
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, Mutex as AsyncMutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub repo: String,
    pub filename: String,
    pub display_name: String,
    pub size_bytes: u64,
    pub size_gb: f64,
    pub min_ram_gb: f64,
    pub supports_image_input: bool,
    pub supports_audio_input: bool,
    pub supports_video_input: bool,
    pub supports_thinking: bool,
    pub max_context_tokens: u32,
    pub recommended_max_output_tokens: u32,
}

impl From<&RuntimeModelSpec> for ModelInfo {
    fn from(model: &RuntimeModelSpec) -> Self {
        Self {
            id: model.id.clone(),
            repo: model.repo.clone(),
            filename: model.filename.clone(),
            display_name: model.display_name.clone(),
            size_bytes: model.size_bytes,
            size_gb: model.size_gb,
            min_ram_gb: model.min_ram_gb,
            supports_image_input: model.supports_image_input,
            supports_audio_input: model.supports_audio_input,
            supports_video_input: model.supports_video_input,
            supports_thinking: model.supports_thinking,
            max_context_tokens: model.max_context_tokens,
            recommended_max_output_tokens: model.recommended_max_output_tokens,
        }
    }
}

fn runtime_manifest() -> &'static RuntimeManifest {
    embedded_runtime_manifest().expect("embedded runtime manifest should parse")
}

fn runtime_platform() -> &'static PlatformRuntimeSpec {
    runtime_manifest()
        .platform_for_current_target()
        .expect("supported runtime platform should exist")
}

fn runtime_policy() -> &'static RuntimePolicy {
    &runtime_manifest().policy
}

fn runtime_models() -> &'static [RuntimeModelSpec] {
    runtime_manifest().models.as_slice()
}

fn runtime_version() -> &'static str {
    runtime_platform().runtime_version.as_str()
}

fn python_worker_binary_name() -> &'static str {
    runtime_platform().python_worker_binary_name.as_str()
}

fn default_model_for_ram_gb(total_ram_gb: f64) -> &'static RuntimeModelSpec {
    runtime_manifest()
        .default_model_for_ram_gb(total_ram_gb)
        .or_else(|| runtime_models().first())
        .expect("runtime manifest should include at least one model")
}

fn default_model() -> &'static RuntimeModelSpec {
    default_model_for_ram_gb(get_system_ram_gb())
}

fn find_model(id: &str) -> Option<&'static RuntimeModelSpec> {
    runtime_manifest().model_by_id(id)
}

fn model_info(model: &RuntimeModelSpec) -> ModelInfo {
    ModelInfo::from(model)
}

fn model_download_url(model: &RuntimeModelSpec) -> String {
    format!(
        "https://huggingface.co/{}/resolve/main/{}",
        model.repo.as_str(),
        model.filename.as_str()
    )
}

fn default_backend() -> &'static str {
    runtime_policy().default_backend.as_str()
}

fn backend_label(backend: &str) -> &'static str {
    match backend {
        "gpu" => "GPU",
        "cpu" => "CPU",
        _ => "Unknown",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RuntimeFeatureSupport {
    supports_native_tools: bool,
    supports_audio_input: bool,
    supports_image_input: bool,
    supports_video_input: bool,
    supports_thinking: bool,
}

fn runtime_feature_support(model: &RuntimeModelSpec) -> RuntimeFeatureSupport {
    RuntimeFeatureSupport {
        supports_native_tools: true,
        supports_audio_input: model.supports_audio_input,
        supports_image_input: model.supports_image_input,
        supports_video_input: model.supports_video_input,
        supports_thinking: model.supports_thinking,
    }
}

fn get_system_ram_gb() -> f64 {
    let mut system = System::new();
    system.refresh_memory();
    system.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0)
}

fn ram_support_error(model: &RuntimeModelSpec, total_ram: f64) -> Option<String> {
    if total_ram < model.min_ram_gb {
        Some(format!(
            "Not enough RAM for {} ({:.1} GB required, {:.1} GB available)",
            model.display_name.as_str(),
            model.min_ram_gb,
            total_ram
        ))
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BackendType {
    LiteRtLm,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendStatus {
    pub backend: BackendType,
    pub connected: bool,
    pub models: Vec<String>,
    pub base_url: String,
    pub total_ram_gb: f64,
    pub state: String,
    pub message: String,
    pub supports_native_tools: bool,
    pub supports_audio_input: bool,
    pub supports_image_input: bool,
    pub supports_video_input: bool,
    pub supports_thinking: bool,
    pub max_context_tokens: u32,
    pub recommended_max_output_tokens: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub model_id: String,
    pub model_display_name: String,
    pub model_downloaded: bool,
    pub model_size_gb: f64,
    pub min_ram_gb: f64,
    pub total_ram_gb: f64,
    pub meets_ram_minimum: bool,
    pub runtime_installed: bool,
    pub ready_to_chat: bool,
    pub partial_download_bytes: u64,
}

#[derive(Debug, Clone, PartialEq)]
struct ParsedDownloadProgress {
    downloaded_bytes: u64,
    total_bytes: u64,
    speed_bps: u64,
    eta_seconds: u64,
    percentage: u64,
}

struct DownloadProgressPayload<'a> {
    state: &'a str,
    display_name: &'a str,
    downloaded_bytes: u64,
    total_bytes: u64,
    speed_bps: u64,
    eta_seconds: u64,
    percentage: u64,
    error: Option<&'a str>,
}

#[derive(Debug, Clone, Copy)]
enum ProcessStream {
    Stdout,
    Stderr,
}

pub struct SidecarManager {
    pub status: Mutex<BackendStatus>,
    models_dir: Mutex<Option<PathBuf>>,
    resource_dir: Mutex<Option<PathBuf>>,
    daemon: Arc<AsyncMutex<Option<PythonWorkerClient>>>,
    daemon_startup: Arc<AsyncMutex<()>>,
    runtime_install_lock: AsyncMutex<()>,
    model_download_locks: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    active_model_id: Mutex<String>,
    max_tokens: AtomicU32,
    runtime_installed: Mutex<Option<bool>>,
    daemon_activity: Arc<DaemonActivity>,
    selected_backend: Mutex<String>,
    downloaded_model_ids_cache: Mutex<Option<Vec<String>>>,
    web_search_base_url: Mutex<Option<String>>,
}

struct DaemonActivity {
    last_activity: Mutex<Instant>,
    active_uses: AtomicUsize,
    monitor_started: AtomicBool,
}

impl DaemonActivity {
    fn new() -> Self {
        Self {
            last_activity: Mutex::new(Instant::now()),
            active_uses: AtomicUsize::new(0),
            monitor_started: AtomicBool::new(false),
        }
    }

    fn touch(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }

    fn idle_deadline_reached(&self, now: Instant) -> bool {
        let last_activity = *self.last_activity.lock().unwrap();
        active_uses_idle(self.active_uses.load(Ordering::SeqCst), last_activity, now)
    }
}

pub struct DaemonUseGuard {
    activity: Arc<DaemonActivity>,
}

impl Drop for DaemonUseGuard {
    fn drop(&mut self) {
        self.activity.touch();
        self.activity.active_uses.fetch_sub(1, Ordering::SeqCst);
    }
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(unavailable_status(
                "runtime_missing",
                "LiteRT-LM bundled runtime is not ready yet.",
            )),
            models_dir: Mutex::new(None),
            resource_dir: Mutex::new(None),
            daemon: Arc::new(AsyncMutex::new(None)),
            daemon_startup: Arc::new(AsyncMutex::new(())),
            runtime_install_lock: AsyncMutex::new(()),
            model_download_locks: AsyncMutex::new(HashMap::new()),
            active_model_id: Mutex::new(default_model().id.to_string()),
            max_tokens: AtomicU32::new(4096),
            runtime_installed: Mutex::new(None),
            daemon_activity: Arc::new(DaemonActivity::new()),
            selected_backend: Mutex::new(default_backend().to_string()),
            downloaded_model_ids_cache: Mutex::new(None),
            web_search_base_url: Mutex::new(None),
        }
    }

    pub fn set_models_dir(&self, path: PathBuf) {
        tracing::info!("Models directory set: {:?}", path);
        std::fs::create_dir_all(&path).ok();
        *self.models_dir.lock().unwrap() = Some(path);
        *self.runtime_installed.lock().unwrap() = None;
        self.invalidate_downloaded_model_ids_cache();
        self.cleanup_stale_runtime_processes();
        self.ensure_idle_monitor();
    }

    pub fn set_resource_dir(&self, path: PathBuf) {
        tracing::info!("Resource directory set: {:?}", path);
        *self.resource_dir.lock().unwrap() = Some(path);
        *self.runtime_installed.lock().unwrap() = None;
    }

    pub fn set_max_tokens(&self, max_tokens: u32) {
        self.max_tokens.store(max_tokens, Ordering::SeqCst);
    }

    pub fn set_web_search_base_url(&self, base_url: &str) {
        *self.web_search_base_url.lock().unwrap() = Some(base_url.to_string());
    }

    fn selected_backend(&self) -> String {
        self.selected_backend.lock().unwrap().clone()
    }

    pub fn active_model(&self) -> &'static RuntimeModelSpec {
        let id = self.active_model_id.lock().unwrap().clone();
        find_model(&id).unwrap_or(default_model())
    }

    pub fn set_active_model_id(&self, model_id: &str) {
        let selected = find_model(model_id).unwrap_or(default_model());
        *self.active_model_id.lock().unwrap() = selected.id.to_string();
    }

    pub fn model_for_request(
        &self,
        model_id: Option<&str>,
    ) -> Result<&'static RuntimeModelSpec, String> {
        match model_id {
            Some(id) => find_model(id).ok_or_else(|| format!("Unknown model: {}", id)),
            None => Ok(self.active_model()),
        }
    }

    pub fn ensure_model_ram_supported(&self, model: &RuntimeModelSpec) -> Result<(), String> {
        let total_ram = get_system_ram_gb();
        if let Some(error) = ram_support_error(model, total_ram) {
            return Err(error);
        }
        Ok(())
    }

    pub fn has_model(&self) -> bool {
        self.has_model_for(self.active_model())
    }

    pub fn has_model_for(&self, model: &RuntimeModelSpec) -> bool {
        self.downloaded_model_ids()
            .into_iter()
            .any(|id| id == model.id.as_str())
    }

    fn partial_model_download_bytes(&self, model: &RuntimeModelSpec) -> u64 {
        self.model_storage_path(model)
            .ok()
            .and_then(|path| std::fs::metadata(path).ok().map(|metadata| metadata.len()))
            .unwrap_or(0)
    }

    fn invalidate_downloaded_model_ids_cache(&self) {
        *self.downloaded_model_ids_cache.lock().unwrap() = None;
    }

    fn query_downloaded_model_ids(&self) -> Result<Vec<String>, String> {
        let binary = self.lit_binary_path()?;
        if !binary.exists() {
            return Ok(Vec::new());
        }

        let output = std::process::Command::new(binary)
            .arg("list")
            .env("LIT_DIR", self.lit_home_dir_path().unwrap_or_default())
            .output()
            .map_err(|error| format!("Failed to probe downloaded models: {}", error))?;
        if !output.status.success() {
            return Err(format!(
                "Model probe failed with status {}",
                output.status
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout
            .lines()
            .skip_while(|line| !line.starts_with("ID"))
            .skip(1)
            .filter_map(|line| {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with("No models") {
                    return None;
                }
                trimmed.split_whitespace().next().map(|s| s.to_string())
            })
            .collect())
    }

    pub fn downloaded_model_ids(&self) -> Vec<String> {
        if let Some(cached) = self.downloaded_model_ids_cache.lock().unwrap().clone() {
            return cached;
        }

        match self.query_downloaded_model_ids() {
            Ok(downloaded) => {
                *self.downloaded_model_ids_cache.lock().unwrap() = Some(downloaded.clone());
                downloaded
            }
            Err(error) => {
                tracing::warn!("Failed to refresh downloaded model ids: {}", error);
                Vec::new()
            }
        }
    }

    pub fn get_setup_status(&self) -> SetupStatus {
        let total_ram = get_system_ram_gb();
        let runtime_installed = self.is_runtime_installed();
        let model = self.active_model();
        let model_downloaded = self.has_model_for(model);
        let meets_ram_minimum = total_ram >= model.min_ram_gb;

        SetupStatus {
            model_id: model.id.to_string(),
            model_display_name: model.display_name.clone(),
            model_downloaded,
            model_size_gb: model.size_gb,
            min_ram_gb: model.min_ram_gb,
            total_ram_gb: total_ram,
            meets_ram_minimum,
            runtime_installed,
            ready_to_chat: runtime_installed && model_downloaded && meets_ram_minimum,
            partial_download_bytes: if model_downloaded {
                model.size_bytes
            } else {
                self.partial_model_download_bytes(model)
            },
        }
    }

    pub async fn auto_detect(&self) -> BackendStatus {
        let runtime_installed = self.is_runtime_installed();
        let model = self.active_model();
        let features = runtime_feature_support(model);
        let model_downloaded = self.has_model_for(model);
        let total_ram_gb = get_system_ram_gb();
        let ram_error = ram_support_error(model, total_ram_gb);
        let daemon_running = if runtime_installed && model_downloaded {
            self.daemon_is_running().await
        } else {
            false
        };

        let status = if let Some(error) = ram_error {
            unavailable_status("insufficient_ram", error)
        } else if runtime_installed && model_downloaded && daemon_running {
            BackendStatus {
                backend: BackendType::LiteRtLm,
                connected: true,
                models: vec![model.id.to_string()],
                base_url: String::new(),
                total_ram_gb,
                state: "connected".to_string(),
                message: format!(
                    "LiteRT-LM {} with {} is ready in Friday's Python worker on {}.",
                    runtime_version(),
                    model.display_name.as_str(),
                    backend_label(&self.selected_backend())
                ),
                supports_native_tools: features.supports_native_tools,
                supports_audio_input: features.supports_audio_input,
                supports_image_input: features.supports_image_input,
                supports_video_input: features.supports_video_input,
                supports_thinking: features.supports_thinking,
                max_context_tokens: model.max_context_tokens,
                recommended_max_output_tokens: model.recommended_max_output_tokens,
            }
        } else if runtime_installed && model_downloaded {
            BackendStatus {
                backend: BackendType::LiteRtLm,
                connected: false,
                models: vec![model.id.to_string()],
                base_url: String::new(),
                total_ram_gb,
                state: "ready".to_string(),
                message: format!(
                    "LiteRT-LM {} with {} is ready to start in Friday's Python worker on {}.",
                    runtime_version(),
                    model.display_name.as_str(),
                    backend_label(default_backend())
                ),
                supports_native_tools: features.supports_native_tools,
                supports_audio_input: features.supports_audio_input,
                supports_image_input: features.supports_image_input,
                supports_video_input: features.supports_video_input,
                supports_thinking: features.supports_thinking,
                max_context_tokens: model.max_context_tokens,
                recommended_max_output_tokens: model.recommended_max_output_tokens,
            }
        } else if !runtime_installed {
            unavailable_status(
                "runtime_missing",
                "LiteRT-LM bundled runtime is not ready yet. Complete setup to prepare it.",
            )
        } else {
            unavailable_status(
                "model_missing",
                format!(
                    "{} is not downloaded yet. Complete setup to download it.",
                    model.display_name.as_str()
                ),
            )
        };

        self.set_status(status.clone());
        status
    }

    pub async fn ensure_ready(&self) -> Result<(), String> {
        let model = self.active_model();
        self.ensure_model_ram_supported(model)?;
        if !self.has_model_for(model) {
            return Err(format!(
                "{} is not downloaded yet. Complete setup to download it.",
                model.display_name.as_str()
            ));
        }
        self.ensure_runtime(None).await?;
        Ok(())
    }

    pub async fn daemon_is_running(&self) -> bool {
        let mut guard = self.daemon.lock().await;
        if let Some(daemon) = guard.as_ref() {
            let model_path = match self.model_storage_path(self.active_model()) {
                Ok(path) => path,
                Err(_) => return false,
            };
            let max_tokens = self.max_tokens.load(Ordering::SeqCst);
            let backend = self.selected_backend();

            if daemon.matches(&model_path, max_tokens, &backend) && daemon.is_alive().await {
                return true;
            }

            tracing::warn!("Friday LiteRT Python worker is no longer usable; restarting on demand");
            if let Some(daemon) = guard.take() {
                let _ = daemon.send_shutdown().await;
            }
        }

        false
    }

    pub fn begin_daemon_use(&self) -> DaemonUseGuard {
        self.daemon_activity.touch();
        self.daemon_activity
            .active_uses
            .fetch_add(1, Ordering::SeqCst);
        DaemonUseGuard {
            activity: Arc::clone(&self.daemon_activity),
        }
    }

    pub async fn cancel_inference(&self) -> Result<(), String> {
        let mut guard = self.daemon.lock().await;
        let Some(_) = guard.as_ref() else {
            return Ok(());
        };

        let (cancel_result, daemon_alive) = {
            let daemon = guard
                .as_ref()
                .ok_or_else(|| "Friday LiteRT Python worker is not available".to_string())?;
            tracing::info!("Cancelling Friday LiteRT Python worker request");
            let cancel_result = daemon.cancel_active_request().await;
            let daemon_alive = daemon.is_alive().await;
            (cancel_result, daemon_alive)
        };

        if !daemon_alive {
            let _ = guard.take();
        }

        cancel_result
            .map_err(|error| format!("Failed to cancel Friday LiteRT Python worker: {}", error))
    }

    pub async fn shutdown_daemon(&self) -> Result<(), String> {
        let mut guard = self.daemon.lock().await;
        if let Some(daemon) = guard.take() {
            tracing::info!("Stopping Friday LiteRT Python worker (app shutdown)");
            let _ = daemon.send_shutdown().await;
        }
        Ok(())
    }

    pub async fn ensure_daemon(&self) -> Result<(), String> {
        let _startup_guard = self.daemon_startup.lock().await;

        {
            let mut guard = self.daemon.lock().await;
            if let Some(daemon) = guard.as_ref() {
                let model_path = self.model_storage_path(self.active_model())?;
                let max_tokens = self.max_tokens.load(Ordering::SeqCst);
                let backend = self.selected_backend();

                if daemon.matches(&model_path, max_tokens, &backend) && daemon.is_alive().await {
                    return Ok(());
                }
                tracing::warn!("Replacing Friday LiteRT Python worker to match the active config");
                if let Some(daemon) = guard.take() {
                    let _ = daemon.send_shutdown().await;
                }
            }
        }

        self.start_daemon_inner().await
    }

    async fn spawn_daemon_worker(
        &self,
        config: PythonWorkerSpawnConfig<'_>,
    ) -> Result<PythonWorkerClient, String> {
        PythonWorkerClient::spawn(config).await
    }

    async fn start_daemon_inner(&self) -> Result<(), String> {
        self.ensure_ready().await?;

        let max_tokens = self.max_tokens.load(Ordering::SeqCst);
        let model = self.active_model();
        let model_path = self.model_storage_path(model)?;
        let python_binary = self.python_worker_binary_path()?;
        let worker_script = self.python_worker_script_path()?;
        let python_site_packages = self.python_site_packages_path()?;
        let python_runtime_lib_dir = self.python_runtime_lib_dir_path()?;
        let preferred_backend = default_backend();
        let web_search_base_url = self.web_search_base_url.lock().unwrap().clone();

        tracing::info!(
            "Starting Friday LiteRT Python worker (model={}, max_num_tokens={}, backend={})…",
            model.id.as_str(),
            max_tokens,
            preferred_backend,
        );

        let (client, selected_backend) = match self
            .spawn_daemon_worker(PythonWorkerSpawnConfig {
                python_binary: &python_binary,
                worker_script: &worker_script,
                model_path: &model_path,
                max_num_tokens: max_tokens,
                backend: preferred_backend,
                web_search_base_url: web_search_base_url.as_deref(),
                python_site_packages: &python_site_packages,
                python_runtime_lib_dir: &python_runtime_lib_dir,
            })
            .await
        {
            Ok(client) => (client, preferred_backend),
            Err(primary_error) if preferred_backend != "cpu" => {
                tracing::warn!(
                    "Friday LiteRT Python worker failed to start on {}: {}. Falling back to CPU.",
                    backend_label(preferred_backend),
                    primary_error
                );

                match self
                    .spawn_daemon_worker(PythonWorkerSpawnConfig {
                        python_binary: &python_binary,
                        worker_script: &worker_script,
                        model_path: &model_path,
                        max_num_tokens: max_tokens,
                        backend: "cpu",
                        web_search_base_url: web_search_base_url.as_deref(),
                        python_site_packages: &python_site_packages,
                        python_runtime_lib_dir: &python_runtime_lib_dir,
                    })
                    .await
                {
                    Ok(client) => (client, "cpu"),
                    Err(fallback_error) => {
                        return Err(format!(
                            "Failed to start Friday LiteRT Python worker on {}: {}. CPU fallback also failed: {}",
                            backend_label(preferred_backend),
                            primary_error,
                            fallback_error
                        ));
                    }
                }
            }
            Err(error) => return Err(error),
        };

        let mut guard = self.daemon.lock().await;
        if let Some(existing) = guard.take() {
            tracing::warn!("Replacing existing Friday LiteRT Python worker");
            let _ = existing.send_shutdown().await;
        }
        *guard = Some(client);
        self.daemon_activity.touch();
        *self.selected_backend.lock().unwrap() = selected_backend.to_string();
        tracing::info!(
            "Friday LiteRT Python worker started on {}",
            backend_label(selected_backend)
        );
        Ok(())
    }

    pub async fn start_inference_with_options(
        &self,
        _session_id: &str,
        messages: &[ChatMessage],
        generation_config: GenerationRequestConfig,
        tools_enabled: bool,
    ) -> Result<mpsc::Receiver<StreamEvent>, String> {
        self.ensure_daemon().await?;

        let guard = self.daemon.lock().await;
        let daemon = guard
            .as_ref()
            .ok_or_else(|| "Friday LiteRT Python worker is not available".to_string())?;

        daemon
            .send_chat_with_options(messages, generation_config, tools_enabled)
            .await
    }

    pub async fn download_model(
        &self,
        app: &tauri::AppHandle,
        model: &RuntimeModelSpec,
    ) -> Result<(), String> {
        let model_download_lock = self.model_download_lock(model.id.as_str()).await;
        let _model_download_guard = model_download_lock.lock().await;

        self.ensure_runtime(Some(app)).await?;
        if self.has_model_for(model) {
            Self::emit_progress(Some(app), "complete", &model.display_name);
            return Ok(());
        }

        Self::emit_progress(Some(app), "downloading", &model.display_name);
        let url = model_download_url(model);
        let stop_progress = Arc::new(AtomicBool::new(false));
        let progress_handle = self.spawn_model_download_progress_monitor(
            app.clone(),
            model,
            Arc::clone(&stop_progress),
        );
        self.run_lit_with_progress(
            &["pull", &url, "--alias", model.id.as_str()],
            "Downloading model",
            Some(app),
            &model.display_name,
        )
        .await
        .inspect_err(|error| {
            stop_progress.store(true, Ordering::SeqCst);
            Self::emit_download_progress(
                Some(app),
                &DownloadProgressPayload {
                    state: "error",
                    display_name: &model.display_name,
                    downloaded_bytes: self.partial_model_download_bytes(model),
                    total_bytes: model.size_bytes,
                    speed_bps: 0,
                    eta_seconds: 0,
                    percentage: 0,
                    error: Some(error),
                },
            );
        })?;
        stop_progress.store(true, Ordering::SeqCst);
        if let Some(handle) = progress_handle {
            let _ = handle.await;
        }
        self.invalidate_downloaded_model_ids_cache();
        Self::emit_progress(Some(app), "complete", &model.display_name);
        self.set_status(self.auto_detect().await);
        Ok(())
    }

    pub fn set_status(&self, status: BackendStatus) {
        *self.status.lock().unwrap() = status;
    }

    fn ensure_idle_monitor(&self) {
        if self
            .daemon_activity
            .monitor_started
            .swap(true, Ordering::SeqCst)
        {
            return;
        }

        let daemon = Arc::clone(&self.daemon);
        let activity = Arc::clone(&self.daemon_activity);

        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(runtime_policy().daemon_idle_check_interval());
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                interval.tick().await;

                if !activity.idle_deadline_reached(Instant::now()) {
                    continue;
                }

                let mut guard = daemon.lock().await;
                if activity.active_uses.load(Ordering::SeqCst) > 0
                    || !activity.idle_deadline_reached(Instant::now())
                {
                    continue;
                }

                let Some(daemon) = guard.take() else {
                    continue;
                };

                if !daemon.is_alive().await {
                    continue;
                }

                tracing::info!(
                    "Stopping Friday LiteRT Python worker after {:?} of inactivity to free RAM",
                    runtime_policy().daemon_idle_timeout()
                );

                if daemon.send_shutdown().await.is_err() {
                    let _ = daemon.kill().await;
                }
            }
        });
    }

    fn app_data_dir(&self) -> Result<PathBuf, String> {
        self.models_dir
            .lock()
            .unwrap()
            .clone()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .ok_or_else(|| "App data directory not configured".to_string())
    }

    fn runtime_dir_path(&self) -> Result<PathBuf, String> {
        Ok(self
            .app_data_dir()?
            .join("litert-runtime")
            .join(runtime_version()))
    }

    fn resource_dir_path(&self) -> Result<PathBuf, String> {
        self.resource_dir
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "Resource directory not configured".to_string())
    }

    fn lit_home_dir_path(&self) -> Result<PathBuf, String> {
        Ok(self.app_data_dir()?.join("lit-home"))
    }

    fn model_storage_path(&self, model: &RuntimeModelSpec) -> Result<PathBuf, String> {
        Ok(self
            .lit_home_dir_path()?
            .join("models")
            .join(&model.id)
            .join("model.litertlm"))
    }

    fn lit_binary_path(&self) -> Result<PathBuf, String> {
        let runtime_dir = self.runtime_dir_path()?;
        let file_name = runtime_platform()
            .litert_binary
            .file_name("LiteRT runtime")?;
        Ok(runtime_dir.join(file_name))
    }

    fn python_runtime_dir_path(&self) -> Result<PathBuf, String> {
        Ok(self.runtime_dir_path()?.join("python"))
    }

    fn python_runtime_lib_dir_path(&self) -> Result<PathBuf, String> {
        Ok(self.python_runtime_dir_path()?.join("lib"))
    }

    fn python_binary_path(&self) -> Result<PathBuf, String> {
        Ok(self.python_runtime_dir_path()?.join("bin").join("python3"))
    }

    fn python_worker_binary_path(&self) -> Result<PathBuf, String> {
        Ok(self
            .python_runtime_dir_path()?
            .join("bin")
            .join(python_worker_binary_name()))
    }

    fn python_site_packages_path(&self) -> Result<PathBuf, String> {
        Ok(self.runtime_dir_path()?.join("python-site"))
    }

    fn python_wheelhouse_dir_path(&self) -> Result<PathBuf, String> {
        Ok(self.runtime_dir_path()?.join("wheelhouse"))
    }

    fn python_worker_script_path(&self) -> Result<PathBuf, String> {
        let file_name = runtime_platform()
            .worker_script
            .file_name("Python worker script")?;
        Ok(self.runtime_dir_path()?.join("worker").join(file_name))
    }

    fn bundled_resource_source_path(&self, relative_path: &str) -> Result<PathBuf, String> {
        Ok(bundled_resource_source_path(
            &self.resource_dir_path()?,
            relative_path,
        ))
    }

    fn bundled_runtime_source_path(&self) -> Result<PathBuf, String> {
        self.bundled_resource_source_path(&runtime_platform().litert_binary.relative_resource_path)
    }

    fn bundled_python_wheel_source_path(&self) -> Result<PathBuf, String> {
        self.bundled_resource_source_path(&runtime_platform().python_wheel.relative_resource_path)
    }

    fn bundled_python_worker_source_path(&self) -> Result<PathBuf, String> {
        self.bundled_resource_source_path(&runtime_platform().worker_script.relative_resource_path)
    }

    fn cleanup_stale_runtime_processes(&self) {
        let Ok(lit_binary) = self.lit_binary_path() else {
            return;
        };
        let Ok(python_binary) = self.python_binary_path() else {
            return;
        };
        if !lit_binary.exists() && !python_binary.exists() {
            return;
        }

        let canonical_binary = std::fs::canonicalize(&lit_binary).unwrap_or(lit_binary);
        let canonical_python = std::fs::canonicalize(&python_binary).unwrap_or(python_binary);
        let worker_script = self
            .python_worker_script_path()
            .ok()
            .and_then(|path| std::fs::canonicalize(path).ok());
        let mut system = System::new_all();
        system.refresh_processes(ProcessesToUpdate::All, true);

        for process in system.processes().values() {
            let Some(exe) = process.exe() else {
                continue;
            };
            let canonical_exe = std::fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
            if canonical_exe == canonical_binary
                && process
                    .cmd()
                    .iter()
                    .any(|arg| arg.to_string_lossy() == "serve")
            {
                tracing::warn!(
                    "Killing orphaned LiteRT-LM server from previous run (pid={})",
                    process.pid()
                );
                let _ = process.kill();
                continue;
            }

            if canonical_exe == canonical_python
                && worker_script.as_ref().is_some_and(|script| {
                    process.cmd().iter().any(|arg| {
                        std::fs::canonicalize(arg)
                            .map(|path| &path == script)
                            .unwrap_or(false)
                    })
                })
            {
                tracing::warn!(
                    "Killing orphaned Friday LiteRT Python worker from previous run (pid={})",
                    process.pid()
                );
                let _ = process.kill();
            }
        }
    }

    async fn model_download_lock(&self, model_id: &str) -> Arc<AsyncMutex<()>> {
        let mut guard = self.model_download_locks.lock().await;
        guard
            .entry(model_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    fn command_output_summary(output: &std::process::Output) -> String {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            return stderr;
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return stdout;
        }
        "no output".to_string()
    }

    fn ensure_file_checksum_matches(
        label: &str,
        expected_path: &Path,
        actual_path: &Path,
    ) -> Result<(), String> {
        let expected_hash = sha256_file_hex(expected_path)?;
        let actual_hash = sha256_file_hex(actual_path)?;
        if expected_hash != actual_hash {
            return Err(format!(
                "{} checksum mismatch at {}. Installed runtime does not match bundled assets.",
                label,
                actual_path.display()
            ));
        }
        Ok(())
    }

    fn validate_runtime_installation(&self) -> Result<(), String> {
        let lit_binary = self.lit_binary_path()?;
        let python_binary = self.python_binary_path()?;
        let worker_launcher = self.python_worker_binary_path()?;
        let worker_script = self.python_worker_script_path()?;
        let python_site_packages = self.python_site_packages_path()?;
        let python_runtime_lib_dir = self.python_runtime_lib_dir_path()?;

        if !lit_binary.exists() {
            return Err(format!(
                "LiteRT runtime binary is missing at {}.",
                lit_binary.display()
            ));
        }
        if !python_binary.exists() {
            return Err(format!(
                "Bundled Python interpreter is missing at {}.",
                python_binary.display()
            ));
        }
        validate_python_worker_launcher(&python_binary, &worker_launcher)?;
        if !worker_script.exists() {
            return Err(format!(
                "Friday Python worker script is missing at {}.",
                worker_script.display()
            ));
        }
        if !python_site_packages
            .join("litert_lm")
            .join("__init__.py")
            .exists()
        {
            return Err(format!(
                "Bundled LiteRT Python package is missing at {}.",
                python_site_packages.display()
            ));
        }

        let bundled_lit_binary = self.bundled_runtime_source_path()?;
        let bundled_worker_script = self.bundled_python_worker_source_path()?;
        Self::ensure_file_checksum_matches(
            "LiteRT runtime binary",
            &bundled_lit_binary,
            &lit_binary,
        )?;
        Self::ensure_file_checksum_matches(
            "Friday Python worker script",
            &bundled_worker_script,
            &worker_script,
        )?;

        let lit_probe = std::process::Command::new(&lit_binary)
            .arg("list")
            .env("LIT_DIR", self.lit_home_dir_path()?)
            .output()
            .map_err(|error| format!("Failed to run LiteRT runtime probe: {}", error))?;
        if !lit_probe.status.success() {
            return Err(format!(
                "LiteRT runtime warm probe failed: {}",
                Self::command_output_summary(&lit_probe)
            ));
        }

        let import_probe = std::process::Command::new(&python_binary)
            .arg("-c")
            .arg("import litert_lm")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONPATH", python_site_packages.display().to_string())
            .env("DYLD_LIBRARY_PATH", python_runtime_lib_dir)
            .output()
            .map_err(|error| format!("Failed to run embedded Python import probe: {}", error))?;
        if !import_probe.status.success() {
            return Err(format!(
                "Embedded Python import probe failed: {}",
                Self::command_output_summary(&import_probe)
            ));
        }

        Ok(())
    }

    fn is_runtime_installed(&self) -> bool {
        if let Some(cached) = *self.runtime_installed.lock().unwrap() {
            return cached;
        }

        let installed = match self.validate_runtime_installation() {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!("Friday runtime validation failed: {}", error);
                false
            }
        };
        *self.runtime_installed.lock().unwrap() = Some(installed);
        installed
    }

    pub async fn ensure_runtime(&self, app: Option<&tauri::AppHandle>) -> Result<(), String> {
        let _runtime_install_guard = self.runtime_install_lock.lock().await;

        Self::emit_progress(app, "verifying", "");
        if let Ok(()) = self.validate_runtime_installation() {
            *self.runtime_installed.lock().unwrap() = Some(true);
            return Ok(());
        }

        *self.runtime_installed.lock().unwrap() = Some(false);
        let runtime_dir = self.runtime_dir_path()?;
        let platform = runtime_platform();
        std::fs::create_dir_all(&runtime_dir)
            .map_err(|e| format!("Failed to create runtime directory: {}", e))?;
        std::fs::create_dir_all(self.lit_home_dir_path()?)
            .map_err(|e| format!("Failed to create LiteRT home directory: {}", e))?;

        let lit_source_path = self.bundled_runtime_source_path()?;
        let python_wheel_source_path = self.bundled_python_wheel_source_path()?;
        let python_worker_source_path = self.bundled_python_worker_source_path()?;

        for source_path in [
            &lit_source_path,
            &python_wheel_source_path,
            &python_worker_source_path,
        ] {
            if source_path.exists() {
                continue;
            }
            return Err(format!(
                "Bundled Friday LiteRT runtime asset is missing at {}. Rebuild the app so the runtime is packaged.",
                source_path.display()
            ));
        }

        let binary_path = self.lit_binary_path()?;
        if !binary_path.exists() {
            tracing::info!(
                "Installing bundled Friday LiteRT runtime into {}",
                runtime_dir.display()
            );

            let temp_path = runtime_dir.join(if cfg!(windows) {
                "lit.exe.part"
            } else {
                "lit.part"
            });
            if temp_path.exists() {
                let _ = std::fs::remove_file(&temp_path);
            }
            std::fs::copy(&lit_source_path, &temp_path)
                .map_err(|e| format!("Failed to copy bundled LiteRT-LM runtime: {}", e))?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("Failed to mark LiteRT-LM runtime executable: {}", e))?;
            }

            std::fs::rename(&temp_path, &binary_path)
                .map_err(|e| format!("Failed to finalize LiteRT-LM runtime install: {}", e))?;
        }

        ensure_embedded_python_runtime(
            &self.app_data_dir()?,
            &self.resource_dir_path()?,
            &platform.runtime_version,
            &platform.python_runtime_archive.relative_resource_path,
        )?;
        install_python_worker_launcher(
            &self.python_binary_path()?,
            &self.python_worker_binary_path()?,
        )?;

        let wheelhouse_dir = self.python_wheelhouse_dir_path()?;
        std::fs::create_dir_all(&wheelhouse_dir)
            .map_err(|e| format!("Failed to create Python wheelhouse directory: {}", e))?;
        let wheel_target_path =
            wheelhouse_dir.join(platform.python_wheel.file_name("LiteRT Python wheel")?);
        let wheel_changed =
            sync_file_if_changed(&python_wheel_source_path, &wheel_target_path, false)?;
        let python_site_packages = self.python_site_packages_path()?;
        if wheel_changed
            || !python_site_packages
                .join("litert_lm")
                .join("__init__.py")
                .exists()
        {
            install_python_wheel(&wheel_target_path, &python_site_packages)?;
        }

        let worker_target_path = self.python_worker_script_path()?;
        let _ = sync_file_if_changed(&python_worker_source_path, &worker_target_path, true)?;

        self.validate_runtime_installation().map_err(|error| {
            format!("Friday runtime validation failed after install: {}", error)
        })?;
        *self.runtime_installed.lock().unwrap() = Some(true);
        self.invalidate_downloaded_model_ids_cache();
        tracing::info!("Friday LiteRT runtime installed successfully from bundle");
        Ok(())
    }

    async fn run_lit_with_progress(
        &self,
        args: &[&str],
        description: &str,
        app: Option<&tauri::AppHandle>,
        display_name: &str,
    ) -> Result<(), String> {
        let binary = self.lit_binary_path()?;
        let lit_dir = self.lit_home_dir_path()?;
        let mut child = tokio::process::Command::new(binary)
            .args(args)
            .env("LIT_DIR", lit_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run {}: {}", description, e))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("Failed to capture {} stdout", description))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| format!("Failed to capture {} stderr", description))?;

        let (tx, mut rx) = mpsc::unbounded_channel::<(ProcessStream, Vec<u8>)>();
        let stdout_tx = tx.clone();
        tokio::spawn(async move {
            read_process_stream(stdout, ProcessStream::Stdout, stdout_tx).await;
        });
        let stderr_tx = tx.clone();
        tokio::spawn(async move {
            read_process_stream(stderr, ProcessStream::Stderr, stderr_tx).await;
        });
        drop(tx);

        let mut stdout_tail = String::new();
        let mut stderr_tail = String::new();
        let mut stdout_fragment = String::new();
        let mut stderr_fragment = String::new();
        let mut last_progress: Option<ParsedDownloadProgress> = None;

        while let Some((stream, chunk)) = rx.recv().await {
            let text = String::from_utf8_lossy(&chunk);
            match stream {
                ProcessStream::Stdout => append_limited(&mut stdout_tail, &text),
                ProcessStream::Stderr => append_limited(&mut stderr_tail, &text),
            }

            let buffer = match stream {
                ProcessStream::Stdout => &mut stdout_fragment,
                ProcessStream::Stderr => &mut stderr_fragment,
            };

            for segment in split_progress_segments(buffer, &text) {
                let Some(progress) = parse_download_progress(&segment) else {
                    continue;
                };
                if last_progress.as_ref() == Some(&progress) {
                    continue;
                }
                last_progress = Some(progress.clone());
                Self::emit_download_progress(
                    app,
                    &DownloadProgressPayload {
                        state: "downloading",
                        display_name,
                        downloaded_bytes: progress.downloaded_bytes,
                        total_bytes: progress.total_bytes,
                        speed_bps: progress.speed_bps,
                        eta_seconds: progress.eta_seconds,
                        percentage: normalize_incomplete_download_percentage(progress.percentage),
                        error: None,
                    },
                );
            }
        }

        for segment in [stdout_fragment, stderr_fragment] {
            let Some(progress) = parse_download_progress(&segment) else {
                continue;
            };
            if last_progress.as_ref() == Some(&progress) {
                continue;
            }
            last_progress = Some(progress.clone());
            Self::emit_download_progress(
                app,
                &DownloadProgressPayload {
                    state: "downloading",
                    display_name,
                    downloaded_bytes: progress.downloaded_bytes,
                    total_bytes: progress.total_bytes,
                    speed_bps: progress.speed_bps,
                    eta_seconds: progress.eta_seconds,
                    percentage: normalize_incomplete_download_percentage(progress.percentage),
                    error: None,
                },
            );
        }

        let status = child
            .wait()
            .await
            .map_err(|e| format!("Failed to run {}: {}", description, e))?;

        if status.success() {
            return Ok(());
        }

        let stderr = stderr_tail.trim().to_string();
        let stdout = stdout_tail.trim().to_string();
        let details = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "no output".to_string()
        };

        Err(format!("{} failed: {}", description, details))
    }

    fn emit_progress(app: Option<&tauri::AppHandle>, state: &str, display_name: &str) {
        Self::emit_download_progress(
            app,
            &DownloadProgressPayload {
                state,
                display_name,
                downloaded_bytes: 0,
                total_bytes: 0,
                speed_bps: 0,
                eta_seconds: 0,
                percentage: if state == "complete" { 100 } else { 0 },
                error: None,
            },
        );
    }

    fn emit_download_progress(
        app: Option<&tauri::AppHandle>,
        payload: &DownloadProgressPayload<'_>,
    ) {
        if let Some(app) = app {
            let _ = app.emit(
                "model-download-progress",
                serde_json::json!({
                    "state": payload.state,
                    "displayName": payload.display_name,
                    "downloadedBytes": payload.downloaded_bytes,
                    "totalBytes": payload.total_bytes,
                    "speedBps": payload.speed_bps,
                    "etaSeconds": payload.eta_seconds,
                    "percentage": payload.percentage,
                    "error": payload.error,
                }),
            );
        }
    }

    fn spawn_model_download_progress_monitor(
        &self,
        app: tauri::AppHandle,
        model: &RuntimeModelSpec,
        stop_flag: Arc<AtomicBool>,
    ) -> Option<tauri::async_runtime::JoinHandle<()>> {
        let model_path = self.model_storage_path(model).ok()?;
        let display_name = model.display_name.to_string();
        let total_bytes = model.size_bytes;

        Some(tauri::async_runtime::spawn(async move {
            let mut last_bytes = 0u64;
            let mut last_emit = Instant::now();

            loop {
                let downloaded_bytes = std::fs::metadata(&model_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);

                if downloaded_bytes > 0 && downloaded_bytes != last_bytes {
                    let elapsed = last_emit.elapsed().as_secs_f64().max(0.001);
                    let delta = downloaded_bytes.saturating_sub(last_bytes);
                    let speed_bps = (delta as f64 / elapsed) as u64;
                    let eta_seconds = if total_bytes > downloaded_bytes && speed_bps > 0 {
                        (total_bytes - downloaded_bytes) / speed_bps
                    } else {
                        0
                    };
                    let percentage =
                        ((downloaded_bytes as f64 / total_bytes as f64) * 100.0).round() as u64;

                    SidecarManager::emit_download_progress(
                        Some(&app),
                        &DownloadProgressPayload {
                            state: "downloading",
                            display_name: &display_name,
                            downloaded_bytes,
                            total_bytes,
                            speed_bps,
                            eta_seconds,
                            percentage: normalize_incomplete_download_percentage(percentage),
                            error: None,
                        },
                    );

                    last_bytes = downloaded_bytes;
                    last_emit = Instant::now();
                }

                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }

                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        }))
    }
}

async fn read_process_stream<R>(
    mut reader: R,
    stream: ProcessStream,
    sender: mpsc::UnboundedSender<(ProcessStream, Vec<u8>)>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = [0u8; 8192];
    loop {
        let Ok(read) = reader.read(&mut buffer).await else {
            break;
        };
        if read == 0 {
            break;
        }
        if sender.send((stream, buffer[..read].to_vec())).is_err() {
            break;
        }
    }
}

fn append_limited(target: &mut String, chunk: &str) {
    target.push_str(chunk);
    let limit = runtime_policy().process_output_tail_limit_bytes;
    if target.len() > limit {
        let overflow = target.len() - limit;
        target.drain(..overflow);
    }
}

fn split_progress_segments(buffer: &mut String, chunk: &str) -> Vec<String> {
    let mut segments = Vec::new();
    for ch in chunk.chars() {
        if ch == '\r' || ch == '\n' {
            let segment = buffer.trim();
            if !segment.is_empty() {
                segments.push(segment.to_string());
            }
            buffer.clear();
        } else {
            buffer.push(ch);
        }
    }
    segments
}

fn parse_download_progress(line: &str) -> Option<ParsedDownloadProgress> {
    let line = line.trim();
    let percent_marker = line.find("%|")?;
    let percent_start = line[..percent_marker]
        .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|idx| idx + 1)
        .unwrap_or(0);
    let percentage = line[percent_start..percent_marker]
        .trim()
        .parse::<f64>()
        .ok()?
        .round() as u64;

    let after_percent = &line[percent_marker + 2..];
    let details_start = after_percent.find('|')?;
    let details = after_percent[details_start + 1..].trim();
    let size_token = details.split_whitespace().next()?;
    let (downloaded_bytes, total_bytes) = parse_transferred_sizes(size_token)?;

    let (eta_seconds, speed_bps) = if let Some(bracket_start) = details.find('[') {
        let bracket_body = details[bracket_start + 1..].split(']').next().unwrap_or("");
        parse_timing_and_speed(bracket_body)
    } else {
        (0, 0)
    };

    Some(ParsedDownloadProgress {
        downloaded_bytes,
        total_bytes,
        speed_bps,
        eta_seconds,
        percentage: percentage.min(100),
    })
}

fn parse_transferred_sizes(token: &str) -> Option<(u64, u64)> {
    let (downloaded, total) = token.split_once('/')?;
    Some((
        parse_size_to_bytes(downloaded)?,
        parse_size_to_bytes(total)?,
    ))
}

fn parse_timing_and_speed(token: &str) -> (u64, u64) {
    let parts: Vec<_> = token.split(',').map(str::trim).collect();
    let speed_bps = parts
        .last()
        .and_then(|speed| speed.strip_suffix("/s"))
        .and_then(parse_size_to_bytes)
        .unwrap_or(0);
    let eta_seconds = token
        .split('<')
        .nth(1)
        .and_then(|rest| rest.split(',').next())
        .and_then(parse_duration_to_seconds)
        .unwrap_or(0);
    (eta_seconds, speed_bps)
}

fn parse_duration_to_seconds(token: &str) -> Option<u64> {
    let mut total = 0u64;
    let mut multiplier = 1u64;
    let parts: Vec<_> = token.trim().split(':').collect();
    if parts.is_empty() {
        return None;
    }
    for part in parts.iter().rev() {
        let value = part.trim().parse::<u64>().ok()?;
        total = total.checked_add(value.checked_mul(multiplier)?)?;
        multiplier = multiplier.checked_mul(60)?;
    }
    Some(total)
}

fn parse_size_to_bytes(token: &str) -> Option<u64> {
    let cleaned = token.trim();
    if cleaned.is_empty() {
        return None;
    }

    let number_end = cleaned
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(cleaned.len());
    let value = cleaned[..number_end].parse::<f64>().ok()?;
    let unit = cleaned[number_end..].trim().to_ascii_uppercase();
    let multiplier = match unit.as_str() {
        "" | "B" => 1f64,
        "K" | "KB" | "KIB" => 1024f64,
        "M" | "MB" | "MIB" => 1024f64.powi(2),
        "G" | "GB" | "GIB" => 1024f64.powi(3),
        "T" | "TB" | "TIB" => 1024f64.powi(4),
        _ => return None,
    };
    Some((value * multiplier).round() as u64)
}

fn unavailable_status(state: &str, message: impl AsRef<str>) -> BackendStatus {
    BackendStatus {
        backend: BackendType::LiteRtLm,
        connected: false,
        models: Vec::new(),
        base_url: String::new(),
        total_ram_gb: get_system_ram_gb(),
        state: state.to_string(),
        message: message.as_ref().to_string(),
        supports_native_tools: false,
        supports_audio_input: false,
        supports_image_input: false,
        supports_video_input: false,
        supports_thinking: false,
        max_context_tokens: 0,
        recommended_max_output_tokens: 0,
    }
}

fn active_uses_idle(active_uses: usize, last_activity: Instant, now: Instant) -> bool {
    active_uses == 0
        && now.saturating_duration_since(last_activity) >= runtime_policy().daemon_idle_timeout()
}

fn normalize_incomplete_download_percentage(percentage: u64) -> u64 {
    percentage.min(99)
}

fn install_python_worker_launcher(
    python_binary: &Path,
    launcher_path: &Path,
) -> Result<(), String> {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    if !python_binary.exists() {
        return Err(format!(
            "Bundled Python runtime is missing its interpreter at {}.",
            python_binary.display()
        ));
    }
    let source_binary =
        std::fs::canonicalize(python_binary).unwrap_or_else(|_| python_binary.to_path_buf());

    let launcher_parent = launcher_path.parent().ok_or_else(|| {
        format!(
            "Friday worker launcher path {} has no parent directory.",
            launcher_path.display()
        )
    })?;
    std::fs::create_dir_all(launcher_parent).map_err(|e| {
        format!(
            "Failed to create Friday worker launcher directory {}: {}",
            launcher_parent.display(),
            e
        )
    })?;

    let needs_refresh = match std::fs::symlink_metadata(launcher_path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                true
            } else {
                let source_metadata = std::fs::metadata(&source_binary).map_err(|e| {
                    format!(
                        "Failed to read bundled Python interpreter metadata {}: {}",
                        source_binary.display(),
                        e
                    )
                })?;
                if source_metadata.len() != metadata.len() {
                    true
                } else {
                    let source_bytes = std::fs::read(&source_binary).map_err(|e| {
                        format!(
                            "Failed to read bundled Python interpreter {}: {}",
                            source_binary.display(),
                            e
                        )
                    })?;
                    let target_bytes = std::fs::read(launcher_path).map_err(|e| {
                        format!(
                            "Failed to read installed Friday worker launcher {}: {}",
                            launcher_path.display(),
                            e
                        )
                    })?;
                    source_bytes != target_bytes
                }
            }
        }
        Err(_) => true,
    };

    if !needs_refresh {
        return Ok(());
    }

    if launcher_path.exists() {
        std::fs::remove_file(launcher_path).map_err(|e| {
            format!(
                "Failed to replace stale Friday worker launcher {}: {}",
                launcher_path.display(),
                e
            )
        })?;
    }

    if std::fs::hard_link(&source_binary, launcher_path).is_ok() {
        return Ok(());
    }

    std::fs::copy(&source_binary, launcher_path).map_err(|e| {
        format!(
            "Failed to copy Friday worker launcher to {}: {}",
            launcher_path.display(),
            e
        )
    })?;

    #[cfg(unix)]
    {
        std::fs::set_permissions(launcher_path, std::fs::Permissions::from_mode(0o755)).map_err(
            |e| {
                format!(
                    "Failed to mark Friday worker launcher executable {}: {}",
                    launcher_path.display(),
                    e
                )
            },
        )?;
    }

    Ok(())
}

fn validate_python_worker_launcher(python_binary: &Path, launcher_path: &Path) -> Result<(), String> {
    if !launcher_path.exists() {
        return Err(format!(
            "Friday Python worker launcher is missing at {}.",
            launcher_path.display()
        ));
    }

    let source_binary =
        std::fs::canonicalize(python_binary).unwrap_or_else(|_| python_binary.to_path_buf());
    let source_metadata = std::fs::metadata(&source_binary).map_err(|e| {
        format!(
            "Failed to read bundled Python interpreter metadata {}: {}",
            source_binary.display(),
            e
        )
    })?;
    let launcher_metadata = std::fs::metadata(launcher_path).map_err(|e| {
        format!(
            "Failed to read Friday worker launcher metadata {}: {}",
            launcher_path.display(),
            e
        )
    })?;

    if source_metadata.len() != launcher_metadata.len() {
        return Err(format!(
            "Friday Python worker launcher at {} does not match the bundled Python interpreter.",
            launcher_path.display()
        ));
    }

    let source_bytes = std::fs::read(&source_binary).map_err(|e| {
        format!(
            "Failed to read bundled Python interpreter {}: {}",
            source_binary.display(),
            e
        )
    })?;
    let launcher_bytes = std::fs::read(launcher_path).map_err(|e| {
        format!(
            "Failed to read Friday worker launcher {}: {}",
            launcher_path.display(),
            e
        )
    })?;

    if source_bytes != launcher_bytes {
        return Err(format!(
            "Friday Python worker launcher at {} does not match the bundled Python interpreter.",
            launcher_path.display()
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn detect_backend(manager: State<'_, SidecarManager>) -> Result<BackendStatus, String> {
    Ok(manager.auto_detect().await)
}

#[tauri::command]
pub async fn pull_model(
    manager: State<'_, SidecarManager>,
    app: tauri::AppHandle,
    model_id: Option<String>,
) -> Result<String, String> {
    let model = manager.model_for_request(model_id.as_deref())?;
    manager.ensure_model_ram_supported(model)?;
    manager.download_model(&app, model).await?;
    Ok(format!("{} downloaded", model.display_name.as_str()))
}

#[tauri::command]
pub async fn get_backend_status(
    manager: State<'_, SidecarManager>,
) -> Result<BackendStatus, String> {
    Ok(manager.auto_detect().await)
}

#[tauri::command]
pub fn get_setup_status(manager: State<'_, SidecarManager>) -> Result<SetupStatus, String> {
    Ok(manager.get_setup_status())
}

#[derive(Serialize)]
pub struct SystemInfo {
    pub total_ram_gb: f64,
    pub backend_type: String,
    pub connected: bool,
    pub models: Vec<String>,
    pub model_downloaded: bool,
}

#[tauri::command]
pub async fn get_system_info(manager: State<'_, SidecarManager>) -> Result<SystemInfo, String> {
    let status = manager.auto_detect().await;
    Ok(SystemInfo {
        total_ram_gb: status.total_ram_gb,
        backend_type: match status.backend {
            BackendType::LiteRtLm => "litert-lm".to_string(),
            BackendType::None => "none".to_string(),
        },
        connected: status.connected,
        models: status.models.clone(),
        model_downloaded: manager.has_model(),
    })
}

#[tauri::command]
pub fn list_models() -> Vec<ModelInfo> {
    runtime_models().iter().map(model_info).collect()
}

#[tauri::command]
pub fn get_active_model(manager: State<'_, SidecarManager>) -> ModelInfo {
    model_info(manager.active_model())
}

#[tauri::command]
pub fn list_downloaded_model_ids(manager: State<'_, SidecarManager>) -> Vec<String> {
    manager.downloaded_model_ids()
}

#[tauri::command]
pub async fn select_model(
    manager: State<'_, SidecarManager>,
    state: State<'_, AppState>,
    model_id: String,
) -> Result<ModelInfo, String> {
    let model = find_model(&model_id).ok_or_else(|| format!("Unknown model: {}", model_id))?;
    manager.ensure_model_ram_supported(model)?;
    manager.invalidate_downloaded_model_ids_cache();

    if !manager.has_model_for(model) {
        return Err(format!(
            "{} is not downloaded yet. Download it before switching.",
            model.display_name.as_str()
        ));
    }

    manager.cancel_inference().await?;

    {
        let guard = state.db.lock().unwrap();
        let conn = guard.as_ref().ok_or("Database not initialized")?;
        persist_active_model_id(conn, &model_id)?;
    }

    manager.set_active_model_id(&model_id);
    manager.invalidate_downloaded_model_ids_cache();
    Ok(model_info(model))
}

#[tauri::command]
pub async fn warm_backend(manager: State<'_, SidecarManager>) -> Result<BackendStatus, String> {
    manager.ensure_daemon().await?;
    Ok(manager.auto_detect().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_model(id: &str) -> &'static RuntimeModelSpec {
        find_model(id).expect("manifest model")
    }

    #[test]
    fn manifest_model_metadata_is_consistent() {
        for model in runtime_models() {
            assert!(model.filename.ends_with(".litertlm"));
            assert!(!model.repo.is_empty());
            assert!(model.size_bytes > 0);
            assert!(model.max_context_tokens > 0);
            assert!(model.recommended_max_output_tokens > 0);
        }
    }

    #[test]
    fn default_backend_prefers_gpu_for_python_worker() {
        assert_eq!(default_backend(), "gpu");
    }

    #[test]
    fn unavailable_status_is_disconnected() {
        let status = unavailable_status("runtime_missing", "runtime missing");
        assert!(!status.connected);
        assert_eq!(status.state, "runtime_missing");
        assert!(!status.supports_image_input);
        assert_eq!(status.max_context_tokens, 0);
    }

    #[test]
    fn runtime_platform_assets_resolve_from_manifest() {
        let platform = runtime_platform();
        assert_eq!(platform.runtime_version, "0.10.1");
        assert_eq!(platform.python_worker_binary_name, "friday-worker");
        assert_eq!(
            platform.worker_script.relative_resource_path,
            "litert-python/macos-aarch64/worker/friday_litert_worker.py"
        );
    }

    #[test]
    fn model_for_request_does_not_mutate_active_selection() {
        let manager = SidecarManager::new();
        let original_model_id = manager.active_model().id.to_string();
        let requested = manager
            .model_for_request(Some("gemma-4-e4b-it"))
            .expect("requested model");
        assert_eq!(requested.id, "gemma-4-e4b-it");
        assert_eq!(manager.active_model().id, original_model_id);
    }

    #[test]
    fn ready_status_is_not_connected() {
        let model = default_model();
        let features = runtime_feature_support(model);
        let status = BackendStatus {
            backend: BackendType::LiteRtLm,
            connected: false,
            models: vec![model.id.to_string()],
            base_url: String::new(),
            total_ram_gb: 16.0,
            state: "ready".to_string(),
            message: format!(
                "LiteRT-LM {} with {} is ready to start.",
                runtime_version(),
                model.display_name.as_str()
            ),
            supports_native_tools: features.supports_native_tools,
            supports_audio_input: features.supports_audio_input,
            supports_image_input: features.supports_image_input,
            supports_video_input: features.supports_video_input,
            supports_thinking: features.supports_thinking,
            max_context_tokens: model.max_context_tokens,
            recommended_max_output_tokens: model.recommended_max_output_tokens,
        };

        assert!(!status.connected);
        assert_eq!(status.state, "ready");
        assert!(status.supports_image_input);
        assert!(status.supports_native_tools);
    }

    #[test]
    fn runtime_feature_support_reports_multimodal_and_native_tools() {
        let supports = runtime_feature_support(default_model());
        assert!(supports.supports_audio_input);
        assert!(supports.supports_image_input);
        assert!(supports.supports_native_tools);
    }

    #[test]
    fn ram_support_error_reports_insufficient_memory() {
        let error = ram_support_error(manifest_model("gemma-4-e4b-it"), 4.0)
            .expect("ram check should fail");
        assert!(error.contains("Not enough RAM"));
        assert!(ram_support_error(manifest_model("gemma-4-e2b-it"), 8.0).is_none());
    }

    #[test]
    fn low_ram_systems_default_to_e2b() {
        assert_eq!(default_model_for_ram_gb(16.0).id, "gemma-4-e2b-it");
        assert_eq!(default_model_for_ram_gb(8.0).id, "gemma-4-e2b-it");
    }

    #[test]
    fn high_ram_systems_default_to_e4b() {
        assert_eq!(default_model_for_ram_gb(16.1).id, "gemma-4-e4b-it");
        assert_eq!(default_model_for_ram_gb(32.0).id, "gemma-4-e4b-it");
    }

    #[test]
    fn parse_download_progress_handles_tqdm_output() {
        let progress = parse_download_progress(
            "gemma-4-E4B-it.litertlm:  23%|██▎       | 840M/3.40G [01:23<04:10, 11.2MB/s]",
        )
        .expect("progress should parse");

        assert_eq!(progress.percentage, 23);
        assert_eq!(progress.downloaded_bytes, 880_803_840);
        assert_eq!(progress.total_bytes, 3_650_722_202);
        assert_eq!(progress.eta_seconds, 250);
        assert_eq!(progress.speed_bps, 11_744_051);
    }

    #[test]
    fn incomplete_download_percentage_never_reports_complete() {
        assert_eq!(normalize_incomplete_download_percentage(0), 0);
        assert_eq!(normalize_incomplete_download_percentage(42), 42);
        assert_eq!(normalize_incomplete_download_percentage(100), 99);
        assert_eq!(normalize_incomplete_download_percentage(120), 99);
    }

    #[test]
    fn parse_download_progress_rejects_non_progress_lines() {
        assert!(parse_download_progress(
            "Downloading gemma-4-E4B-it.litertlm from litert-community/gemma-4-E4B-it-litert-lm..."
        )
        .is_none());
        assert!(parse_download_progress("Successfully imported model").is_none());
    }

    #[test]
    fn split_progress_segments_handles_carriage_returns() {
        let mut buffer = String::new();
        let segments = split_progress_segments(
            &mut buffer,
            "10%|█         | 1.0G/10.0G [00:10<01:30, 100MB/s]\r20%|██        | 2.0G/10.0G [00:20<01:20, 100MB/s]\r",
        );

        assert_eq!(segments.len(), 2);
        assert!(buffer.is_empty());
        assert!(segments[0].starts_with("10%|"));
        assert!(segments[1].starts_with("20%|"));
    }

    #[test]
    fn backend_label_is_human_readable() {
        assert_eq!(backend_label("gpu"), "GPU");
        assert_eq!(backend_label("cpu"), "CPU");
        assert_eq!(backend_label("other"), "Unknown");
    }

    #[test]
    fn idle_shutdown_requires_timeout_and_no_active_use() {
        let last_activity = Instant::now();
        let idle_timeout = runtime_policy().daemon_idle_timeout();
        assert!(!active_uses_idle(
            0,
            last_activity,
            last_activity + idle_timeout - Duration::from_secs(1),
        ));
        assert!(active_uses_idle(
            0,
            last_activity,
            last_activity + idle_timeout,
        ));
        assert!(!active_uses_idle(
            1,
            last_activity,
            last_activity + idle_timeout,
        ));
    }

    #[test]
    fn install_python_worker_launcher_points_to_python_binary() {
        let temp_root =
            std::env::temp_dir().join(format!("friday-sidecar-test-{}", uuid::Uuid::new_v4()));
        let python_dir = temp_root.join("python").join("bin");
        std::fs::create_dir_all(&python_dir).expect("create python runtime dir");

        let python_binary_real = python_dir.join("python3.12");
        std::fs::write(&python_binary_real, b"#!/bin/sh\n").expect("write python binary stub");
        let python_binary = python_dir.join("python3");
        #[cfg(unix)]
        std::os::unix::fs::symlink("python3.12", &python_binary).expect("create python symlink");
        #[cfg(not(unix))]
        std::fs::copy(&python_binary_real, &python_binary).expect("copy python binary");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&python_binary_real, std::fs::Permissions::from_mode(0o755))
                .expect("set python binary permissions");
        }

        let launcher_path = python_dir.join(python_worker_binary_name());
        install_python_worker_launcher(&python_binary, &launcher_path).expect("install launcher");

        assert!(launcher_path.exists());
        let launcher_metadata =
            std::fs::symlink_metadata(&launcher_path).expect("read launcher metadata");
        assert!(!launcher_metadata.file_type().is_symlink());
        assert_eq!(
            std::fs::read(&launcher_path).expect("read launcher"),
            std::fs::read(&python_binary_real).expect("read python binary"),
        );

        let _ = std::fs::remove_dir_all(temp_root);
    }

    #[test]
    fn validate_python_worker_launcher_rejects_missing_launcher() {
        let temp_root =
            std::env::temp_dir().join(format!("friday-sidecar-test-{}", uuid::Uuid::new_v4()));
        let python_dir = temp_root.join("python").join("bin");
        std::fs::create_dir_all(&python_dir).expect("create python runtime dir");

        let python_binary_real = python_dir.join("python3.12");
        std::fs::write(&python_binary_real, b"#!/bin/sh\n").expect("write python binary stub");
        let python_binary = python_dir.join("python3");
        #[cfg(unix)]
        std::os::unix::fs::symlink("python3.12", &python_binary).expect("create python symlink");
        #[cfg(not(unix))]
        std::fs::copy(&python_binary_real, &python_binary).expect("copy python binary");

        let launcher_path = python_dir.join(python_worker_binary_name());
        let error = validate_python_worker_launcher(&python_binary, &launcher_path)
            .expect_err("missing launcher should fail validation");
        assert!(error.contains("worker launcher is missing"));

        let _ = std::fs::remove_dir_all(temp_root);
    }

    #[test]
    fn validate_python_worker_launcher_accepts_installed_launcher() {
        let temp_root =
            std::env::temp_dir().join(format!("friday-sidecar-test-{}", uuid::Uuid::new_v4()));
        let python_dir = temp_root.join("python").join("bin");
        std::fs::create_dir_all(&python_dir).expect("create python runtime dir");

        let python_binary_real = python_dir.join("python3.12");
        std::fs::write(&python_binary_real, b"#!/bin/sh\n").expect("write python binary stub");
        let python_binary = python_dir.join("python3");
        #[cfg(unix)]
        std::os::unix::fs::symlink("python3.12", &python_binary).expect("create python symlink");
        #[cfg(not(unix))]
        std::fs::copy(&python_binary_real, &python_binary).expect("copy python binary");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&python_binary_real, std::fs::Permissions::from_mode(0o755))
                .expect("set python binary permissions");
        }

        let launcher_path = python_dir.join(python_worker_binary_name());
        install_python_worker_launcher(&python_binary, &launcher_path).expect("install launcher");
        validate_python_worker_launcher(&python_binary, &launcher_path)
            .expect("installed launcher should validate");

        let _ = std::fs::remove_dir_all(temp_root);
    }
}
