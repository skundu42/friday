use crate::python_runtime::{
    bundled_resource_source_path, ensure_embedded_python_runtime, sha256_bytes_hex, sha256_file_hex,
};
use crate::runtime_manifest::embedded_runtime_manifest;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use sysinfo::{ProcessesToUpdate, System};
use tauri::{Emitter, State};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;

const DEFAULT_HOST_PORT: u16 = 8091;
const BUNDLED_SETTINGS_PATH: &str = "searxng/core-config/settings.yml";
const BUNDLED_SOURCE_MANIFEST_PATH: &str = "searxng/source-manifest.json";
const BUNDLED_REQUIREMENTS_LOCK_MACOS_AARCH64_CP312: &str =
    "searxng/requirements-macos-aarch64-cp312.txt";
const SETTINGS_SECRET_PLACEHOLDER: &str = "__FRIDAY_SEARXNG_SECRET_KEY__";
const SETTINGS_PORT_PLACEHOLDER: &str = "__FRIDAY_SEARXNG_PORT__";
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(3);
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const READY_RETRY_INTERVAL: Duration = Duration::from_millis(750);
const PROCESS_OUTPUT_TAIL_LIMIT: usize = 32 * 1024;
const SOURCE_STAMP_FILENAME: &str = ".friday-source-stamp.json";
const DEPENDENCIES_STAMP_FILENAME: &str = ".friday-dependencies-stamp.json";
const WHEEL_CACHE_STAMP_FILENAME: &str = ".friday-wheel-cache-stamp";

fn ensure_embedded_python_runtime_for_searxng(
    app_data_dir: &Path,
    resource_dir: &Path,
) -> Result<crate::python_runtime::EmbeddedPythonPaths, String> {
    let manifest = embedded_runtime_manifest()?;
    let platform = manifest.platform_for_current_target()?;
    ensure_embedded_python_runtime(
        app_data_dir,
        resource_dir,
        &platform.runtime_version,
        &platform.python_runtime_archive.relative_resource_path,
    )
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchState {
    Unavailable,
    NeedsInstall,
    Stopped,
    Installing,
    Starting,
    Ready,
    ConfigError,
    PortConflict,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchStatus {
    pub provider: String,
    pub available: bool,
    pub running: bool,
    pub healthy: bool,
    pub state: WebSearchState,
    pub message: String,
    pub base_url: String,
}

impl WebSearchStatus {
    fn unavailable(message: impl Into<String>, base_url: String) -> Self {
        Self {
            provider: "searxng".to_string(),
            available: false,
            running: false,
            healthy: false,
            state: WebSearchState::Unavailable,
            message: message.into(),
            base_url,
        }
    }

    fn needs_install(message: impl Into<String>, base_url: String) -> Self {
        Self {
            provider: "searxng".to_string(),
            available: true,
            running: false,
            healthy: false,
            state: WebSearchState::NeedsInstall,
            message: message.into(),
            base_url,
        }
    }

    fn stopped(message: impl Into<String>, base_url: String) -> Self {
        Self {
            provider: "searxng".to_string(),
            available: true,
            running: false,
            healthy: false,
            state: WebSearchState::Stopped,
            message: message.into(),
            base_url,
        }
    }

    fn installing(message: impl Into<String>, base_url: String) -> Self {
        Self {
            provider: "searxng".to_string(),
            available: true,
            running: false,
            healthy: false,
            state: WebSearchState::Installing,
            message: message.into(),
            base_url,
        }
    }

    fn starting(message: impl Into<String>, base_url: String) -> Self {
        Self {
            provider: "searxng".to_string(),
            available: true,
            running: true,
            healthy: false,
            state: WebSearchState::Starting,
            message: message.into(),
            base_url,
        }
    }

    fn config_error(message: impl Into<String>, base_url: String, running: bool) -> Self {
        Self {
            provider: "searxng".to_string(),
            available: false,
            running,
            healthy: false,
            state: WebSearchState::ConfigError,
            message: message.into(),
            base_url,
        }
    }

    fn port_conflict(message: impl Into<String>, base_url: String) -> Self {
        Self {
            provider: "searxng".to_string(),
            available: false,
            running: false,
            healthy: false,
            state: WebSearchState::PortConflict,
            message: message.into(),
            base_url,
        }
    }

    fn ready(message: impl Into<String>, base_url: String) -> Self {
        Self {
            provider: "searxng".to_string(),
            available: true,
            running: true,
            healthy: true,
            state: WebSearchState::Ready,
            message: message.into(),
            base_url,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct SourceManifest {
    version: String,
    commit: String,
    archive_url: String,
    archive_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct InstallState {
    source_version: String,
    source_commit: String,
    source_archive_url: String,
    source_archive_sha256: String,
    requirements_lock_sha256: String,
    installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SourceInstallStamp {
    version: String,
    commit: String,
    archive_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct DependenciesInstallStamp {
    requirements_lock_sha256: String,
}

#[derive(Debug)]
struct ManagedSearxProcess {
    child: Child,
    stdout_tail: Arc<Mutex<String>>,
    stderr_tail: Arc<Mutex<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StartupFailure {
    Generic(String),
    ConfigError(String),
    PortConflict(String),
}

impl StartupFailure {
    fn message(&self) -> &str {
        match self {
            Self::Generic(message) | Self::ConfigError(message) | Self::PortConflict(message) => {
                message
            }
        }
    }

    fn into_status(self, base_url: String) -> WebSearchStatus {
        match self {
            Self::Generic(message) => WebSearchStatus::unavailable(message, base_url),
            Self::ConfigError(message) => WebSearchStatus::config_error(message, base_url, false),
            Self::PortConflict(message) => WebSearchStatus::port_conflict(message, base_url),
        }
    }
}

#[derive(Debug)]
pub struct SearXNGManager {
    status: Mutex<WebSearchStatus>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
    app_data_dir: Mutex<Option<PathBuf>>,
    resource_dir: Mutex<Option<PathBuf>>,
    host_port: AtomicU16,
    process: Arc<AsyncMutex<Option<ManagedSearxProcess>>>,
    startup_lock: AsyncMutex<()>,
    startup_in_progress: AtomicBool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ReadinessProbe {
    Ready,
    Starting(String),
    ConfigError(String),
}

impl SearXNGManager {
    pub fn new() -> Self {
        let host_port = configured_host_port();
        let base_url = base_url_for_port(host_port);
        Self {
            status: Mutex::new(WebSearchStatus::unavailable(
                "Local web search is not configured yet.",
                base_url,
            )),
            app_handle: Mutex::new(None),
            app_data_dir: Mutex::new(None),
            resource_dir: Mutex::new(None),
            host_port: AtomicU16::new(host_port),
            process: Arc::new(AsyncMutex::new(None)),
            startup_lock: AsyncMutex::new(()),
            startup_in_progress: AtomicBool::new(false),
        }
    }

    pub fn set_app_data_dir(&self, path: PathBuf) {
        tracing::info!("SearXNG data directory set: {:?}", path);
        *self.app_data_dir.lock().unwrap() = Some(path);
    }

    pub fn set_resource_dir(&self, path: PathBuf) {
        tracing::info!("SearXNG resource directory set: {:?}", path);
        *self.resource_dir.lock().unwrap() = Some(path);
    }

    pub fn set_app_handle(&self, app_handle: tauri::AppHandle) {
        *self.app_handle.lock().unwrap() = Some(app_handle);
    }

    pub fn base_url(&self) -> String {
        base_url_for_port(self.host_port())
    }

    #[cfg(test)]
    pub fn set_host_port(&self, port: u16) {
        if port > 0 {
            self.host_port.store(port, Ordering::SeqCst);
        }
    }

    pub async fn status(&self) -> WebSearchStatus {
        if self.startup_in_progress.load(Ordering::SeqCst) {
            return self.status.lock().unwrap().clone();
        }

        let status = self.status_inner().await;
        self.set_status(status.clone());
        status
    }

    pub async fn ensure_ready(&self) -> Result<WebSearchStatus, String> {
        let _guard = self.startup_lock.lock().await;
        self.startup_in_progress.store(true, Ordering::SeqCst);

        let result = self.ensure_ready_inner().await;
        self.startup_in_progress.store(false, Ordering::SeqCst);

        match result {
            Ok(status) => {
                self.set_status(status.clone());
                Ok(status)
            }
            Err(error) => {
                let status = self.status_inner().await;
                self.set_status(status);
                Err(error)
            }
        }
    }

    pub async fn reconcile_existing_stack(&self) -> Result<(), String> {
        self.cleanup_stale_processes()?;
        Ok(())
    }

    async fn stop_process(&self) -> Result<(), String> {
        let mut guard = self.process.lock().await;
        if let Some(mut process) = guard.take() {
            tracing::info!("Stopping Friday-managed SearXNG process");
            let _ = process.child.kill().await;
            let _ = process.child.wait().await;
        }

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.stop_process().await?;
        self.set_status(WebSearchStatus::stopped(
            "Local web search was stopped.",
            self.base_url(),
        ));
        Ok(())
    }

    async fn ensure_ready_inner(&self) -> Result<WebSearchStatus, String> {
        self.ensure_supported_platform()?;
        self.ensure_local_assets()?;

        let mut managed_running = self.process_running().await?;
        if !managed_running && !self.port_is_available_or_recovered()? {
            let status =
                WebSearchStatus::port_conflict(self.port_conflict_message(), self.base_url());
            let message = status.message.clone();
            self.set_status(status);
            return Err(message);
        }

        let manifest = self.load_source_manifest()?;
        let requirements_lock = self.requirements_lock_path()?;
        let lock_sha256 = sha256_file_hex(&requirements_lock)?;

        if self.install_needs_refresh(&manifest, &lock_sha256)? {
            self.set_status(WebSearchStatus::installing(
                "Preparing local web search…",
                self.base_url(),
            ));
            if managed_running {
                self.stop_process().await?;
            }
            self.provision_install(&manifest, &requirements_lock, &lock_sha256)
                .await?;
        }

        managed_running = self.process_running().await?;
        if managed_running {
            match self.probe_readiness().await {
                ReadinessProbe::Ready => {
                    return Ok(WebSearchStatus::ready(
                        "Local web search is ready for web-assisted replies.",
                        self.base_url(),
                    ));
                }
                ReadinessProbe::ConfigError(message) => {
                    let status =
                        WebSearchStatus::config_error(message.clone(), self.base_url(), true);
                    self.set_status(status);
                    return Err(message);
                }
                ReadinessProbe::Starting(_) => {
                    tracing::warn!(
                        "Friday-managed SearXNG is running but unhealthy; restarting it"
                    );
                    self.stop_process().await?;
                }
            }
        }

        if !self.port_is_available_or_recovered()? {
            let status =
                WebSearchStatus::port_conflict(self.port_conflict_message(), self.base_url());
            let message = status.message.clone();
            self.set_status(status);
            return Err(message);
        }

        self.set_status(WebSearchStatus::starting(
            "Starting local web search…",
            self.base_url(),
        ));
        self.start_process().await?;

        let started_at = tokio::time::Instant::now();
        loop {
            if !self.process_running().await? {
                let failure = self.process_start_failure().await;
                let message = failure.message().to_string();
                self.set_status(failure.into_status(self.base_url()));
                return Err(message);
            }

            match self.probe_readiness().await {
                ReadinessProbe::Ready => {
                    return Ok(WebSearchStatus::ready(
                        "Local web search is ready for web-assisted replies.",
                        self.base_url(),
                    ));
                }
                ReadinessProbe::ConfigError(message) => {
                    let status =
                        WebSearchStatus::config_error(message.clone(), self.base_url(), true);
                    self.set_status(status);
                    return Err(message);
                }
                ReadinessProbe::Starting(message) => {
                    if started_at.elapsed() >= READY_TIMEOUT {
                        let timeout_message =
                            format!("Local web search did not become ready in time: {}", message);
                        self.set_status(WebSearchStatus::starting(
                            timeout_message.clone(),
                            self.base_url(),
                        ));
                        return Err(timeout_message);
                    }
                }
            }

            tokio::time::sleep(READY_RETRY_INTERVAL).await;
        }
    }

    async fn status_inner(&self) -> WebSearchStatus {
        if let Err(error) = self.ensure_supported_platform() {
            return WebSearchStatus::unavailable(error, self.base_url());
        }

        let manifest = match self.load_source_manifest() {
            Ok(manifest) => manifest,
            Err(error) => return WebSearchStatus::unavailable(error, self.base_url()),
        };
        let requirements_lock = match self.requirements_lock_path() {
            Ok(path) => path,
            Err(error) => return WebSearchStatus::unavailable(error, self.base_url()),
        };
        let lock_sha256 = match sha256_file_hex(&requirements_lock) {
            Ok(hash) => hash,
            Err(error) => return WebSearchStatus::unavailable(error, self.base_url()),
        };

        let install_ready = match self.install_needs_refresh(&manifest, &lock_sha256) {
            Ok(needs_refresh) => !needs_refresh,
            Err(error) => return WebSearchStatus::unavailable(error, self.base_url()),
        };

        let running = match self.process_running().await {
            Ok(running) => running,
            Err(error) => return WebSearchStatus::unavailable(error, self.base_url()),
        };

        if !running {
            if !self.port_is_available_or_recovered().unwrap_or(false) {
                return WebSearchStatus::port_conflict(
                    self.port_conflict_message(),
                    self.base_url(),
                );
            }

            return if install_ready {
                WebSearchStatus::stopped(
                    "Local web search is installed and will start on demand.",
                    self.base_url(),
                )
            } else {
                WebSearchStatus::needs_install(
                    "Local web search will be prepared on first use.",
                    self.base_url(),
                )
            };
        }

        match self.probe_readiness().await {
            ReadinessProbe::Ready => WebSearchStatus::ready(
                "Local web search is ready for web-assisted replies.",
                self.base_url(),
            ),
            ReadinessProbe::ConfigError(message) => {
                WebSearchStatus::config_error(message, self.base_url(), true)
            }
            ReadinessProbe::Starting(message) => {
                WebSearchStatus::starting(message, self.base_url())
            }
        }
    }

    fn set_status(&self, status: WebSearchStatus) {
        let changed = {
            let mut guard = self.status.lock().unwrap();
            if *guard == status {
                false
            } else {
                *guard = status.clone();
                true
            }
        };

        if !changed {
            return;
        }

        let app_handle = self.app_handle.lock().unwrap().clone();
        if let Some(app_handle) = app_handle {
            let _ = app_handle.emit("web-search-status", status);
        }
    }

    fn ensure_supported_platform(&self) -> Result<(), String> {
        let _ = self.requirements_lock_path()?;
        Ok(())
    }

    fn ensure_local_assets(&self) -> Result<(), String> {
        let install_dir = self.install_dir()?;
        let config_dir = self.config_dir()?;
        let download_cache_dir = self.download_cache_dir()?;
        let source_dir = self.source_dir()?;
        std::fs::create_dir_all(&install_dir)
            .map_err(|error| format!("Failed to create SearXNG directory: {}", error))?;
        std::fs::create_dir_all(&config_dir)
            .map_err(|error| format!("Failed to create SearXNG config directory: {}", error))?;
        std::fs::create_dir_all(&download_cache_dir).map_err(|error| {
            format!(
                "Failed to create SearXNG download cache directory: {}",
                error
            )
        })?;
        std::fs::create_dir_all(&source_dir)
            .map_err(|error| format!("Failed to create SearXNG source directory: {}", error))?;

        let settings_template_path =
            bundled_resource_source_path(&self.resource_dir_path()?, BUNDLED_SETTINGS_PATH);
        if !settings_template_path.exists() {
            return Err(format!(
                "Bundled SearXNG settings template is missing at {}.",
                settings_template_path.display()
            ));
        }

        let settings_path = self.settings_path()?;
        let template = std::fs::read_to_string(&settings_template_path).map_err(|error| {
            format!(
                "Failed to read bundled SearXNG settings template {}: {}",
                settings_template_path.display(),
                error
            )
        })?;
        let existing_secret = read_existing_secret_key(&settings_path);
        let secret = existing_secret.unwrap_or_else(generate_secret_key);
        let contents = render_settings_template(&template, &secret, self.host_port());
        std::fs::write(&settings_path, contents).map_err(|error| {
            format!(
                "Failed to write SearXNG settings file {}: {}",
                settings_path.display(),
                error
            )
        })?;

        self.cleanup_legacy_docker_artifacts()?;

        Ok(())
    }

    fn load_source_manifest(&self) -> Result<SourceManifest, String> {
        let manifest_path = if let Some(path) = configured_source_manifest_path() {
            path
        } else {
            bundled_resource_source_path(&self.resource_dir_path()?, BUNDLED_SOURCE_MANIFEST_PATH)
        };
        let bytes = std::fs::read(&manifest_path).map_err(|error| {
            format!(
                "Failed to read SearXNG source manifest {}: {}",
                manifest_path.display(),
                error
            )
        })?;
        let mut manifest: SourceManifest = serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "Failed to parse SearXNG source manifest {}: {}",
                manifest_path.display(),
                error
            )
        })?;

        if let Ok(version) = std::env::var("FRIDAY_SEARXNG_SOURCE_VERSION") {
            manifest.version = version;
        }
        if let Ok(commit) = std::env::var("FRIDAY_SEARXNG_SOURCE_COMMIT") {
            manifest.commit = commit;
        }
        if let Ok(url) = std::env::var("FRIDAY_SEARXNG_SOURCE_URL") {
            manifest.archive_url = url;
        }
        if let Ok(sha256) = std::env::var("FRIDAY_SEARXNG_SOURCE_SHA256") {
            manifest.archive_sha256 = sha256;
        }

        Ok(manifest)
    }

    fn requirements_lock_path(&self) -> Result<PathBuf, String> {
        if let Some(path) = configured_requirements_lock_path() {
            return Ok(path);
        }

        let relative = requirements_lock_relative_path().ok_or_else(|| {
            "Friday web assist is not yet supported on this platform build.".to_string()
        })?;
        let path = bundled_resource_source_path(&self.resource_dir_path()?, relative);
        if !path.exists() {
            return Err(format!(
                "Bundled SearXNG requirements lockfile is missing at {}.",
                path.display()
            ));
        }
        Ok(path)
    }

    fn install_needs_refresh(
        &self,
        manifest: &SourceManifest,
        requirements_lock_sha256: &str,
    ) -> Result<bool, String> {
        let Some(state) = self.read_install_state()? else {
            return Ok(true);
        };

        if state.source_version != manifest.version
            || state.source_commit != manifest.commit
            || state.source_archive_url != manifest.archive_url
            || state.source_archive_sha256 != manifest.archive_sha256
            || state.requirements_lock_sha256 != requirements_lock_sha256
        {
            return Ok(true);
        }

        let source_root = self.source_version_dir(&manifest.version)?;
        if !source_root.join("searx").join("webapp.py").exists() {
            return Ok(true);
        }

        if !source_root.exists() || !self.site_packages_dir()?.exists() {
            return Ok(true);
        }

        let expected_source_stamp = SourceInstallStamp {
            version: manifest.version.clone(),
            commit: manifest.commit.clone(),
            archive_sha256: manifest.archive_sha256.clone(),
        };
        if self.read_source_install_stamp(&manifest.version)? != Some(expected_source_stamp) {
            return Ok(true);
        }

        let expected_dependencies_stamp = DependenciesInstallStamp {
            requirements_lock_sha256: requirements_lock_sha256.to_string(),
        };
        if self.read_dependencies_install_stamp()? != Some(expected_dependencies_stamp) {
            return Ok(true);
        }

        Ok(false)
    }

    fn read_install_state(&self) -> Result<Option<InstallState>, String> {
        let path = self.install_state_path()?;
        if !path.exists() {
            return Ok(None);
        }

        let bytes = std::fs::read(&path)
            .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
        let state = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Failed to parse {}: {}", path.display(), error))?;
        Ok(Some(state))
    }

    fn write_install_state(
        &self,
        manifest: &SourceManifest,
        requirements_lock_sha256: &str,
    ) -> Result<(), String> {
        let state = InstallState {
            source_version: manifest.version.clone(),
            source_commit: manifest.commit.clone(),
            source_archive_url: manifest.archive_url.clone(),
            source_archive_sha256: manifest.archive_sha256.clone(),
            requirements_lock_sha256: requirements_lock_sha256.to_string(),
            installed_at: chrono::Utc::now().to_rfc3339(),
        };
        let bytes = serde_json::to_vec_pretty(&state)
            .map_err(|error| format!("Failed to serialize SearXNG install state: {}", error))?;
        std::fs::write(self.install_state_path()?, bytes)
            .map_err(|error| format!("Failed to write SearXNG install state: {}", error))
    }

    async fn provision_install(
        &self,
        manifest: &SourceManifest,
        requirements_lock: &Path,
        requirements_lock_sha256: &str,
    ) -> Result<(), String> {
        let python = ensure_embedded_python_runtime_for_searxng(
            &self.app_data_dir()?,
            &self.resource_dir_path()?,
        )?;
        tracing::info!(
            "Preparing Friday-managed local SearXNG {} in {}",
            manifest.version,
            self.install_dir()?.display()
        );

        let archive_path = self.download_source_archive(manifest).await?;
        self.download_requirements(
            &python.python_binary,
            requirements_lock,
            requirements_lock_sha256,
        )
        .await?;
        self.install_requirements(
            &python.python_binary,
            requirements_lock,
            requirements_lock_sha256,
        )
        .await?;
        self.unpack_source_archive(&archive_path, manifest)?;
        self.write_install_state(manifest, requirements_lock_sha256)?;
        self.prune_install_artifacts(&manifest.version)?;
        Ok(())
    }

    async fn download_source_archive(&self, manifest: &SourceManifest) -> Result<PathBuf, String> {
        let archive_path = self
            .download_cache_dir()?
            .join(format!("searxng-{}.tar.gz", manifest.version));
        if archive_path.exists() {
            let existing_sha = sha256_file_hex(&archive_path)?;
            if existing_sha == manifest.archive_sha256 {
                return Ok(archive_path);
            }
            let _ = std::fs::remove_file(&archive_path);
        }

        let response = reqwest::get(&manifest.archive_url)
            .await
            .map_err(map_source_download_error)?;
        if !response.status().is_success() {
            return Err(format!(
                "Friday could not download local web search sources (HTTP {}).",
                response.status()
            ));
        }

        let bytes = response.bytes().await.map_err(map_source_download_error)?;
        let actual_sha = sha256_bytes_hex(bytes.as_ref());
        if actual_sha != manifest.archive_sha256 {
            return Err(
                "Friday downloaded an invalid local web search source archive. Please try again."
                    .to_string(),
            );
        }

        let temp_path = archive_path.with_extension("part");
        std::fs::write(&temp_path, bytes.as_ref()).map_err(|error| {
            format!(
                "Failed to write staged SearXNG archive {}: {}",
                temp_path.display(),
                error
            )
        })?;
        std::fs::rename(&temp_path, &archive_path).map_err(|error| {
            format!(
                "Failed to finalize SearXNG archive {}: {}",
                archive_path.display(),
                error
            )
        })?;

        Ok(archive_path)
    }

    async fn download_requirements(
        &self,
        python_binary: &Path,
        requirements_lock: &Path,
        requirements_lock_sha256: &str,
    ) -> Result<(), String> {
        let wheels_dir = self.download_cache_dir()?.join("wheels");
        self.prepare_wheel_cache(&wheels_dir, requirements_lock_sha256)?;

        let mut args = vec![
            "-m".to_string(),
            "pip".to_string(),
            "download".to_string(),
            "--disable-pip-version-check".to_string(),
            "--dest".to_string(),
            wheels_dir.display().to_string(),
            "--only-binary=:all:".to_string(),
            "--require-hashes".to_string(),
            "-r".to_string(),
            requirements_lock.display().to_string(),
        ];
        args.extend(pip_download_platform_args()?);

        let output = self.run_python_command(python_binary, &args).await?;
        if output.status.success() {
            write_text_file(
                &self.wheel_cache_stamp_path()?,
                requirements_lock_sha256,
                "Failed to update wheel cache state",
            )?;
            return Ok(());
        }

        tracing::warn!(
            "SearXNG dependency download failed: {}",
            command_output_text(&output)
        );
        Err(map_pip_download_failure(&output))
    }

    async fn install_requirements(
        &self,
        python_binary: &Path,
        requirements_lock: &Path,
        requirements_lock_sha256: &str,
    ) -> Result<(), String> {
        let wheels_dir = self.download_cache_dir()?.join("wheels");
        let staging_dir = self.site_packages_dir()?.with_extension("staging");
        if staging_dir.exists() {
            let _ = std::fs::remove_dir_all(&staging_dir);
        }

        let args = vec![
            "-m".to_string(),
            "pip".to_string(),
            "install".to_string(),
            "--disable-pip-version-check".to_string(),
            "--no-index".to_string(),
            "--find-links".to_string(),
            wheels_dir.display().to_string(),
            "--require-hashes".to_string(),
            "--target".to_string(),
            staging_dir.display().to_string(),
            "-r".to_string(),
            requirements_lock.display().to_string(),
        ];

        let output = self.run_python_command(python_binary, &args).await?;
        if !output.status.success() {
            tracing::warn!(
                "SearXNG dependency install failed: {}",
                command_output_text(&output)
            );
            let _ = std::fs::remove_dir_all(&staging_dir);
            return Err(map_pip_install_failure(&output));
        }

        let target_dir = self.site_packages_dir()?;
        if target_dir.exists() {
            let _ = std::fs::remove_dir_all(&target_dir);
        }
        std::fs::rename(&staging_dir, &target_dir).map_err(|error| {
            format!(
                "Failed to finalize local web search dependencies {}: {}",
                target_dir.display(),
                error
            )
        })?;
        self.write_dependencies_install_stamp(requirements_lock_sha256)?;
        Ok(())
    }

    fn unpack_source_archive(
        &self,
        archive_path: &Path,
        manifest: &SourceManifest,
    ) -> Result<(), String> {
        let source_root = self.source_dir()?;
        let staging_dir = source_root.join(format!("{}.staging", manifest.version));
        if staging_dir.exists() {
            let _ = std::fs::remove_dir_all(&staging_dir);
        }
        std::fs::create_dir_all(&staging_dir)
            .map_err(|error| format!("Failed to create source staging directory: {}", error))?;

        let archive_file = std::fs::File::open(archive_path).map_err(|error| {
            format!(
                "Failed to open local web search archive {}: {}",
                archive_path.display(),
                error
            )
        })?;
        let decoder = flate2::read::GzDecoder::new(archive_file);
        let mut archive = tar::Archive::new(decoder);
        archive
            .unpack(&staging_dir)
            .map_err(|error| format!("Failed to unpack local web search source: {}", error))?;

        let extracted_root = std::fs::read_dir(&staging_dir)
            .map_err(|error| {
                format!(
                    "Failed to inspect local web search source directory: {}",
                    error
                )
            })?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.is_dir())
            .ok_or_else(|| {
                "Local web search source archive did not contain a top-level directory.".to_string()
            })?;

        let target_dir = self.source_version_dir(&manifest.version)?;
        if target_dir.exists() {
            let _ = std::fs::remove_dir_all(&target_dir);
        }
        std::fs::rename(&extracted_root, &target_dir).map_err(|error| {
            format!(
                "Failed to finalize local web search source {}: {}",
                target_dir.display(),
                error
            )
        })?;
        self.write_source_install_stamp(manifest)?;
        let _ = std::fs::remove_dir_all(&staging_dir);
        Ok(())
    }

    async fn start_process(&self) -> Result<(), String> {
        let python = ensure_embedded_python_runtime_for_searxng(
            &self.app_data_dir()?,
            &self.resource_dir_path()?,
        )?;
        let manifest = self.load_source_manifest()?;
        let source_root = self.source_version_dir(&manifest.version)?;
        let webapp_script = source_root.join("searx").join("webapp.py");
        let site_packages = self.site_packages_dir()?;
        let settings_path = self.settings_path()?;

        let mut command = Command::new(&python.python_binary);
        command
            .arg(&webapp_script)
            .current_dir(&source_root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONNOUSERSITE", "1")
            .env(
                "PYTHONPATH",
                format!("{}:{}", source_root.display(), site_packages.display()),
            )
            .env("SEARXNG_SETTINGS_PATH", settings_path)
            .env("DYLD_LIBRARY_PATH", python.python_lib_dir);

        let mut child = command.spawn().map_err(|error| {
            format!("Failed to start Friday-managed local web search: {}", error)
        })?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdout_tail = Arc::new(Mutex::new(String::new()));
        let stderr_tail = Arc::new(Mutex::new(String::new()));

        if let Some(stdout) = stdout {
            tokio::spawn(read_process_stream(stdout, Arc::clone(&stdout_tail)));
        }
        if let Some(stderr) = stderr {
            tokio::spawn(read_process_stream(stderr, Arc::clone(&stderr_tail)));
        }

        let mut guard = self.process.lock().await;
        *guard = Some(ManagedSearxProcess {
            child,
            stdout_tail,
            stderr_tail,
        });

        Ok(())
    }

    async fn process_running(&self) -> Result<bool, String> {
        let mut guard = self.process.lock().await;
        let Some(process) = guard.as_mut() else {
            return Ok(false);
        };

        match process.child.try_wait() {
            Ok(Some(status)) => {
                tracing::warn!(
                    "Friday-managed SearXNG process exited unexpectedly: {} / {}",
                    status,
                    self.process_logs_from_guard(process)
                );
                *guard = None;
                Ok(false)
            }
            Ok(None) => Ok(true),
            Err(error) => Err(format!(
                "Failed to inspect local web search process state: {}",
                error
            )),
        }
    }

    async fn process_start_failure(&self) -> StartupFailure {
        let guard = self.process.lock().await;
        let Some(process) = guard.as_ref() else {
            return StartupFailure::Generic("Friday could not start local web search.".to_string());
        };
        let logs = self.process_logs_from_guard(process);
        let lower = logs.to_lowercase();
        if lower.contains("address already in use") {
            return StartupFailure::PortConflict(self.port_conflict_message());
        }
        if lower.contains("invalid settings.yml")
            || lower.contains("expected `object`, got `null`")
            || lower.contains("validationerror")
        {
            return StartupFailure::ConfigError(
                "Local SearXNG config is invalid; Friday could not start local web search."
                    .to_string(),
            );
        }
        StartupFailure::Generic("Friday could not start local web search.".to_string())
    }

    fn process_logs_from_guard(&self, process: &ManagedSearxProcess) -> String {
        let stderr = process.stderr_tail.lock().unwrap().trim().to_string();
        if !stderr.is_empty() {
            return stderr;
        }
        process.stdout_tail.lock().unwrap().trim().to_string()
    }

    async fn probe_readiness(&self) -> ReadinessProbe {
        if let Err(error) = self.validate_local_settings() {
            return ReadinessProbe::ConfigError(error);
        }

        let client = match reqwest::Client::builder()
            .timeout(HEALTH_CHECK_TIMEOUT)
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                return ReadinessProbe::Starting(format!(
                    "Failed to create local web search probe client: {}",
                    error
                ));
            }
        };

        let health_url = format!("{}/healthz", self.base_url());
        let health = match client.get(&health_url).send().await {
            Ok(response) => response,
            Err(error) => {
                return ReadinessProbe::Starting(format!(
                    "Local web search is not reachable yet: {}",
                    error
                ));
            }
        };

        if !health.status().is_success() {
            return ReadinessProbe::Starting(format!(
                "Local web search health check failed with HTTP {}",
                health.status()
            ));
        }

        let search_url = format!("{}/search", self.base_url());
        let search = match client
            .get(&search_url)
            .query(&[("q", "friday health check"), ("format", "json")])
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return ReadinessProbe::Starting(format!(
                    "Local web search JSON probe failed: {}",
                    error
                ));
            }
        };

        if search.status() == reqwest::StatusCode::FORBIDDEN {
            return ReadinessProbe::ConfigError(
                "Local SearXNG config is invalid; JSON output is disabled.".to_string(),
            );
        }

        if !search.status().is_success() {
            return ReadinessProbe::Starting(format!(
                "Local web search JSON probe failed with HTTP {}",
                search.status()
            ));
        }

        let payload = match search.json::<serde_json::Value>().await {
            Ok(payload) => payload,
            Err(error) => {
                return ReadinessProbe::Starting(format!(
                    "Local web search JSON probe returned invalid JSON: {}",
                    error
                ));
            }
        };

        if !payload.get("results").is_some_and(|value| value.is_array()) {
            return ReadinessProbe::Starting(
                "Local web search JSON probe did not return a results list.".to_string(),
            );
        }

        ReadinessProbe::Ready
    }

    async fn run_python_command(
        &self,
        python_binary: &Path,
        args: &[String],
    ) -> Result<Output, String> {
        Command::new(python_binary)
            .args(args)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONNOUSERSITE", "1")
            .output()
            .await
            .map_err(|error| {
                format!(
                    "Failed to run Friday-managed Python runtime {}: {}",
                    python_binary.display(),
                    error
                )
            })
    }

    fn cleanup_stale_processes(&self) -> Result<(), String> {
        let app_data_dir = self.app_data_dir()?;
        let resource_dir = self.resource_dir_path()?;
        let python = match ensure_embedded_python_runtime_for_searxng(&app_data_dir, &resource_dir)
        {
            Ok(paths) => paths,
            Err(_) => return Ok(()),
        };

        let source_root = self.source_dir()?;
        let canonical_python =
            std::fs::canonicalize(&python.python_binary).unwrap_or(python.python_binary);
        let mut system = System::new_all();
        system.refresh_processes(ProcessesToUpdate::All, true);

        for process in system.processes().values() {
            let Some(exe) = process.exe() else {
                continue;
            };
            let canonical_exe = std::fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
            if canonical_exe != canonical_python {
                continue;
            }

            let matches_webapp = process.cmd().iter().any(|arg| {
                let path = PathBuf::from(arg);
                path.ends_with(Path::new("searx").join("webapp.py"))
                    && path.starts_with(&source_root)
            });
            if !matches_webapp {
                continue;
            }

            tracing::warn!(
                "Killing orphaned Friday-managed SearXNG process from previous run (pid={})",
                process.pid()
            );
            let _ = process.kill();
        }

        Ok(())
    }

    fn install_dir(&self) -> Result<PathBuf, String> {
        Ok(self.app_data_dir()?.join("searxng"))
    }

    fn source_dir(&self) -> Result<PathBuf, String> {
        Ok(self.install_dir()?.join("source"))
    }

    fn source_version_dir(&self, version: &str) -> Result<PathBuf, String> {
        Ok(self.source_dir()?.join(version))
    }

    fn site_packages_dir(&self) -> Result<PathBuf, String> {
        Ok(self.install_dir()?.join("site-packages"))
    }

    fn download_cache_dir(&self) -> Result<PathBuf, String> {
        Ok(self.install_dir()?.join("download-cache"))
    }

    fn config_dir(&self) -> Result<PathBuf, String> {
        Ok(self.install_dir()?.join("core-config"))
    }

    fn settings_path(&self) -> Result<PathBuf, String> {
        Ok(self.config_dir()?.join("settings.yml"))
    }

    fn install_state_path(&self) -> Result<PathBuf, String> {
        Ok(self.install_dir()?.join("install-state.json"))
    }

    fn cleanup_legacy_docker_artifacts(&self) -> Result<(), String> {
        for path in [
            self.install_dir()?.join(".env"),
            self.install_dir()?.join("docker-compose.yml"),
        ] {
            if !path.exists() {
                continue;
            }
            std::fs::remove_file(&path).map_err(|error| {
                format!(
                    "Failed to remove legacy Docker artifact {}: {}",
                    path.display(),
                    error
                )
            })?;
        }
        Ok(())
    }

    fn host_port(&self) -> u16 {
        self.host_port.load(Ordering::SeqCst)
    }

    fn host_port_is_available(&self) -> bool {
        std::net::TcpListener::bind(("127.0.0.1", self.host_port()))
            .map(|listener| {
                drop(listener);
                true
            })
            .unwrap_or(false)
    }

    fn port_is_available_or_recovered(&self) -> Result<bool, String> {
        if self.host_port_is_available() {
            return Ok(true);
        }

        self.cleanup_stale_processes()?;
        Ok(self.host_port_is_available())
    }

    fn port_conflict_message(&self) -> String {
        format!(
            "Port {} is already in use by another local application. Friday cannot start local web search until that port is free.",
            self.host_port()
        )
    }

    fn validate_local_settings(&self) -> Result<(), String> {
        let settings_path = self.settings_path()?;
        let contents = std::fs::read_to_string(&settings_path).map_err(|error| {
            format!(
                "Failed to read local web search settings {}: {}",
                settings_path.display(),
                error
            )
        })?;

        if !settings_enables_json_output(&contents) {
            return Err("Local SearXNG config is invalid; JSON output is disabled.".to_string());
        }
        if !settings_bind_to_localhost(&contents) {
            return Err(
                "Local SearXNG config is invalid; it must stay bound to 127.0.0.1.".to_string(),
            );
        }

        Ok(())
    }

    fn source_install_stamp_path(&self, version: &str) -> Result<PathBuf, String> {
        Ok(self
            .source_version_dir(version)?
            .join(SOURCE_STAMP_FILENAME))
    }

    fn dependencies_install_stamp_path(&self) -> Result<PathBuf, String> {
        Ok(self.site_packages_dir()?.join(DEPENDENCIES_STAMP_FILENAME))
    }

    fn wheel_cache_stamp_path(&self) -> Result<PathBuf, String> {
        Ok(self
            .download_cache_dir()?
            .join("wheels")
            .join(WHEEL_CACHE_STAMP_FILENAME))
    }

    fn read_source_install_stamp(
        &self,
        version: &str,
    ) -> Result<Option<SourceInstallStamp>, String> {
        read_json_file(&self.source_install_stamp_path(version)?)
    }

    fn write_source_install_stamp(&self, manifest: &SourceManifest) -> Result<(), String> {
        write_json_file(
            &self.source_install_stamp_path(&manifest.version)?,
            &SourceInstallStamp {
                version: manifest.version.clone(),
                commit: manifest.commit.clone(),
                archive_sha256: manifest.archive_sha256.clone(),
            },
            "Failed to write local web search source state",
        )
    }

    fn read_dependencies_install_stamp(&self) -> Result<Option<DependenciesInstallStamp>, String> {
        read_json_file(&self.dependencies_install_stamp_path()?)
    }

    fn write_dependencies_install_stamp(
        &self,
        requirements_lock_sha256: &str,
    ) -> Result<(), String> {
        write_json_file(
            &self.dependencies_install_stamp_path()?,
            &DependenciesInstallStamp {
                requirements_lock_sha256: requirements_lock_sha256.to_string(),
            },
            "Failed to write local web search dependency state",
        )
    }

    fn prepare_wheel_cache(
        &self,
        wheels_dir: &Path,
        requirements_lock_sha256: &str,
    ) -> Result<(), String> {
        let stamp_path = wheels_dir.join(WHEEL_CACHE_STAMP_FILENAME);
        let should_reset = match std::fs::read_to_string(&stamp_path) {
            Ok(contents) => contents.trim() != requirements_lock_sha256,
            Err(_) => true,
        };

        if should_reset && wheels_dir.exists() {
            let _ = std::fs::remove_dir_all(wheels_dir);
        }

        std::fs::create_dir_all(wheels_dir).map_err(|error| {
            format!(
                "Failed to create wheel cache {}: {}",
                wheels_dir.display(),
                error
            )
        })?;
        Ok(())
    }

    fn prune_install_artifacts(&self, current_version: &str) -> Result<(), String> {
        self.prune_source_versions(current_version)?;
        self.prune_cached_archives(current_version)?;
        for stale_path in [
            self.site_packages_dir()?.with_extension("staging"),
            self.source_dir()?
                .join(format!("{}.staging", current_version)),
        ] {
            if stale_path.exists() {
                let _ = std::fs::remove_dir_all(stale_path);
            }
        }
        Ok(())
    }

    fn prune_source_versions(&self, current_version: &str) -> Result<(), String> {
        let source_dir = self.source_dir()?;
        if !source_dir.exists() {
            return Ok(());
        }

        for entry in std::fs::read_dir(&source_dir)
            .map_err(|error| format!("Failed to inspect local web search sources: {}", error))?
        {
            let entry = entry.map_err(|error| {
                format!("Failed to inspect local web search source entry: {}", error)
            })?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if name == current_version {
                continue;
            }
            let _ = std::fs::remove_dir_all(path);
        }

        Ok(())
    }

    fn prune_cached_archives(&self, current_version: &str) -> Result<(), String> {
        let download_cache_dir = self.download_cache_dir()?;
        if !download_cache_dir.exists() {
            return Ok(());
        }

        let current_archive_name = format!("searxng-{}.tar.gz", current_version);
        for entry in std::fs::read_dir(&download_cache_dir).map_err(|error| {
            format!(
                "Failed to inspect local web search download cache: {}",
                error
            )
        })? {
            let entry = entry.map_err(|error| {
                format!("Failed to inspect local web search cache entry: {}", error)
            })?;
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if name == current_archive_name || name == "wheels" {
                continue;
            }
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }

        Ok(())
    }

    fn app_data_dir(&self) -> Result<PathBuf, String> {
        self.app_data_dir
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "SearXNG app data directory is not configured".to_string())
    }

    fn resource_dir_path(&self) -> Result<PathBuf, String> {
        self.resource_dir
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "SearXNG resource directory is not configured".to_string())
    }
}

#[tauri::command]
pub async fn get_web_search_status(
    manager: State<'_, SearXNGManager>,
) -> Result<WebSearchStatus, String> {
    Ok(manager.status().await)
}

fn configured_host_port() -> u16 {
    std::env::var("FRIDAY_SEARXNG_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_HOST_PORT)
}

fn configured_source_manifest_path() -> Option<PathBuf> {
    std::env::var("FRIDAY_SEARXNG_SOURCE_MANIFEST_PATH")
        .ok()
        .map(PathBuf::from)
}

fn configured_requirements_lock_path() -> Option<PathBuf> {
    std::env::var("FRIDAY_SEARXNG_LOCKFILE_PATH")
        .ok()
        .map(PathBuf::from)
}

fn requirements_lock_relative_path() -> Option<&'static str> {
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        Some(BUNDLED_REQUIREMENTS_LOCK_MACOS_AARCH64_CP312)
    } else {
        None
    }
}

fn pip_download_platform_args() -> Result<Vec<String>, String> {
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        return Ok(vec![
            "--implementation".to_string(),
            "cp".to_string(),
            "--python-version".to_string(),
            "312".to_string(),
            "--abi".to_string(),
            "cp312".to_string(),
            "--platform".to_string(),
            "macosx_12_0_arm64".to_string(),
        ]);
    }

    Err("Friday web assist is not yet supported on this platform build.".to_string())
}

fn base_url_for_port(port: u16) -> String {
    format!("http://127.0.0.1:{}", port)
}

fn generate_secret_key() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn settings_enables_json_output(contents: &str) -> bool {
    contents.lines().any(|line| line.trim() == "- json")
}

fn settings_bind_to_localhost(contents: &str) -> bool {
    contents.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == "bind_address: \"127.0.0.1\"" || trimmed == "bind_address: 127.0.0.1"
    })
}

fn render_settings_template(template: &str, secret: &str, port: u16) -> String {
    template
        .replace(SETTINGS_SECRET_PLACEHOLDER, secret)
        .replace(SETTINGS_PORT_PLACEHOLDER, &port.to_string())
}

fn read_existing_secret_key(settings_path: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(settings_path).ok()?;
    extract_secret_key_from_settings(&contents)
}

fn extract_secret_key_from_settings(contents: &str) -> Option<String> {
    for raw_line in contents.lines() {
        let trimmed = raw_line.trim();
        if !trimmed.starts_with("secret_key:") {
            continue;
        }
        let value = trimmed.split_once(':')?.1.trim();
        if value.is_empty() || value == SETTINGS_SECRET_PLACEHOLDER {
            return None;
        }
        return Some(value.trim_matches('"').trim_matches('\'').to_string());
    }
    None
}

fn command_output_text(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }

    format!("Command exited with status {}", output.status)
}

fn read_json_file<T>(path: &Path) -> Result<Option<T>, String>
where
    T: for<'de> Deserialize<'de>,
{
    if !path.exists() {
        return Ok(None);
    }

    let bytes = std::fs::read(path)
        .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
    let parsed = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Failed to parse {}: {}", path.display(), error))?;
    Ok(Some(parsed))
}

fn write_json_file<T>(path: &Path, value: &T, error_context: &str) -> Result<(), String>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{} {}: {}", error_context, parent.display(), error))?;
    }
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("{}: {}", error_context, error))?;
    std::fs::write(path, bytes)
        .map_err(|error| format!("{} {}: {}", error_context, path.display(), error))
}

fn write_text_file(path: &Path, value: &str, error_context: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{} {}: {}", error_context, parent.display(), error))?;
    }
    std::fs::write(path, value)
        .map_err(|error| format!("{} {}: {}", error_context, path.display(), error))
}

fn map_source_download_error(error: reqwest::Error) -> String {
    if error.is_timeout() || error.is_connect() || error.is_request() {
        return "Friday could not download local web search sources. Check your internet connection and try again.".to_string();
    }

    format!(
        "Friday could not download local web search sources: {}",
        error
    )
}

fn map_pip_download_failure(output: &Output) -> String {
    let text = command_output_text(output);
    let lower = text.to_lowercase();
    if is_unsupported_distribution_error(&lower) {
        return "Friday web assist is not yet supported on this platform build.".to_string();
    }
    if lower.contains("hashes are required")
        || lower.contains("do not match the hashes")
        || lower.contains("hash mismatch")
    {
        return "Friday detected an invalid local web search dependency download. Please try again.".to_string();
    }
    if is_network_error_text(&lower) {
        return "Friday could not download local web search dependencies. Check your internet connection and try again.".to_string();
    }

    "Friday could not prepare local web search dependencies.".to_string()
}

fn map_pip_install_failure(output: &Output) -> String {
    let text = command_output_text(output);
    let lower = text.to_lowercase();
    if lower.contains("do not match the hashes") || lower.contains("hash mismatch") {
        return "Friday detected invalid local web search dependency files. Please try again."
            .to_string();
    }
    if is_unsupported_distribution_error(&lower) {
        return "Friday web assist is not yet supported on this platform build.".to_string();
    }

    "Friday could not install local web search dependencies.".to_string()
}

fn is_network_error_text(text: &str) -> bool {
    text.contains("temporary failure in name resolution")
        || text.contains("failed to establish a new connection")
        || text.contains("connection refused")
        || text.contains("connection reset")
        || text.contains("network is unreachable")
        || text.contains("timed out")
        || text.contains("read timed out")
        || text.contains("could not fetch url")
        || text.contains("name or service not known")
}

fn is_unsupported_distribution_error(text: &str) -> bool {
    text.contains("no matching distribution found")
        || text.contains("could not find a version that satisfies the requirement")
        || text.contains("resolutionimpossible")
}

async fn read_process_stream<R>(mut reader: R, target: Arc<Mutex<String>>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = [0u8; 4096];
    loop {
        let Ok(read) = reader.read(&mut buffer).await else {
            break;
        };
        if read == 0 {
            break;
        }
        let chunk = String::from_utf8_lossy(&buffer[..read]);
        append_limited(&mut target.lock().unwrap(), &chunk);
    }
}

fn append_limited(target: &mut String, chunk: &str) {
    target.push_str(chunk);
    if target.len() > PROCESS_OUTPUT_TAIL_LIMIT {
        let overflow = target.len() - PROCESS_OUTPUT_TAIL_LIMIT;
        target.drain(..overflow);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{}-{}", prefix, uuid::Uuid::new_v4()))
    }

    fn write_resource_tree(root: &Path) {
        fs::create_dir_all(root.join("searxng/core-config")).expect("create resource tree");
        fs::write(
            root.join(BUNDLED_SETTINGS_PATH),
            format!(
                "use_default_settings: true\nserver:\n  bind_address: \"127.0.0.1\"\n  port: {}\n  public_instance: false\n  image_proxy: false\n  secret_key: \"{}\"\nsearch:\n  formats:\n    - html\n    - json\n",
                SETTINGS_PORT_PLACEHOLDER, SETTINGS_SECRET_PLACEHOLDER
            ),
        )
        .expect("write settings template");
        fs::write(
            root.join(BUNDLED_SOURCE_MANIFEST_PATH),
            r#"{"version":"2026.4.13-ee66b070a","commit":"ee66b070a9505ae57dbbb49330f004f339743ed8","archive_url":"https://example.com/searxng.tar.gz","archive_sha256":"abc123"}"#,
        )
        .expect("write source manifest");
        fs::write(
            root.join(BUNDLED_REQUIREMENTS_LOCK_MACOS_AARCH64_CP312),
            "flask==3.1.3 --hash=sha256:abc123\n",
        )
        .expect("write lockfile");
    }

    fn write_valid_settings_file(root: &Path, port: u16) {
        let path = root.join("app/searxng/core-config/settings.yml");
        fs::create_dir_all(path.parent().expect("settings parent")).expect("create config dir");
        fs::write(
            path,
            format!(
                "search:\n  formats:\n    - html\n    - json\nserver:\n  bind_address: \"127.0.0.1\"\n  port: {}\n  secret_key: \"secret\"\n",
                port
            ),
        )
        .expect("write settings");
    }

    fn spawn_ready_server() -> (u16, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind readiness server");
        let port = listener.local_addr().expect("server addr").port();
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            for _ in 0..2 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut buffer = [0u8; 1024];
                let read = stream.read(&mut buffer).expect("read request");
                let request = String::from_utf8_lossy(&buffer[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();
                tx.send(path.clone()).expect("send path");

                let response = if path == "/healthz" {
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nok".to_string()
                } else if path.starts_with("/search?") {
                    let body = "{\"query\":\"probe\",\"results\":[]}";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                } else {
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_string()
                };
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
            }
        });

        (port, rx, handle)
    }

    #[test]
    fn base_url_uses_localhost_port() {
        assert_eq!(base_url_for_port(8091), "http://127.0.0.1:8091");
    }

    #[test]
    fn settings_template_is_written_with_secret_and_port() {
        let temp_root = unique_temp_dir("friday-searxng-settings");
        let resource_root = temp_root.join("resources");
        write_resource_tree(&resource_root);

        let manager = SearXNGManager::new();
        manager.set_app_data_dir(temp_root.join("app"));
        manager.set_resource_dir(resource_root);
        manager.ensure_local_assets().expect("sync assets");

        let settings_contents =
            fs::read_to_string(temp_root.join("app/searxng/core-config/settings.yml"))
                .expect("read settings file");
        assert!(settings_contents.contains("bind_address: \"127.0.0.1\""));
        assert!(settings_contents.contains("- json"));
        assert!(settings_contents.contains("use_default_settings: true"));
        assert!(!settings_contents.contains(SETTINGS_SECRET_PLACEHOLDER));
        assert!(!settings_contents.contains(SETTINGS_PORT_PLACEHOLDER));

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn source_manifest_parses_from_bundle() {
        let temp_root = unique_temp_dir("friday-searxng-manifest");
        let resource_root = temp_root.join("resources");
        write_resource_tree(&resource_root);

        let manager = SearXNGManager::new();
        manager.set_app_data_dir(temp_root.join("app"));
        manager.set_resource_dir(resource_root);

        let manifest = manager.load_source_manifest().expect("load manifest");
        assert_eq!(manifest.version, "2026.4.13-ee66b070a");
        assert!(manifest.archive_url.contains("searxng.tar.gz"));

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn install_needs_refresh_when_state_does_not_match() {
        let temp_root = unique_temp_dir("friday-searxng-state");
        let resource_root = temp_root.join("resources");
        write_resource_tree(&resource_root);

        let manager = SearXNGManager::new();
        manager.set_app_data_dir(temp_root.join("app"));
        manager.set_resource_dir(resource_root.clone());
        manager.ensure_local_assets().expect("sync assets");

        let manifest = manager.load_source_manifest().expect("load manifest");
        fs::create_dir_all(
            temp_root
                .join("app/searxng/source")
                .join("2026.4.13-ee66b070a")
                .join("searx"),
        )
        .expect("create source");
        fs::write(
            temp_root
                .join("app/searxng/source")
                .join("2026.4.13-ee66b070a")
                .join("searx")
                .join("webapp.py"),
            "print('ok')",
        )
        .expect("write webapp");
        fs::create_dir_all(temp_root.join("app/searxng/site-packages"))
            .expect("create site-packages");
        manager
            .write_source_install_stamp(&manifest)
            .expect("write source stamp");
        manager
            .write_dependencies_install_stamp("different-lock-hash")
            .expect("write dependency stamp");
        manager
            .write_install_state(&manifest, "different-lock-hash")
            .expect("write install state");

        let needs_refresh = manager
            .install_needs_refresh(&manifest, "expected-lock-hash")
            .expect("check install state");
        assert!(needs_refresh);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn status_does_not_create_local_assets() {
        let temp_root = unique_temp_dir("friday-searxng-status-readonly");
        let resource_root = temp_root.join("resources");
        write_resource_tree(&resource_root);
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral listener");
        let port = listener.local_addr().expect("listener addr").port();
        drop(listener);

        let manager = SearXNGManager::new();
        manager.set_app_data_dir(temp_root.join("app"));
        manager.set_resource_dir(resource_root);
        manager.set_host_port(port);

        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        let status = runtime.block_on(async { manager.status().await });

        assert_eq!(status.state, WebSearchState::NeedsInstall);
        assert!(!temp_root.join("app/searxng").exists());

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn status_does_not_rewrite_existing_settings() {
        let temp_root = unique_temp_dir("friday-searxng-status-preserve");
        let resource_root = temp_root.join("resources");
        write_resource_tree(&resource_root);
        write_valid_settings_file(&temp_root, DEFAULT_HOST_PORT);

        let manager = SearXNGManager::new();
        manager.set_app_data_dir(temp_root.join("app"));
        manager.set_resource_dir(resource_root);

        let settings_path = temp_root.join("app/searxng/core-config/settings.yml");
        let original = fs::read_to_string(&settings_path).expect("read original settings");

        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        let _ = runtime.block_on(async { manager.status().await });

        let rewritten = fs::read_to_string(&settings_path).expect("read settings after status");
        assert_eq!(rewritten, original);

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn status_requires_health_and_json_probes_for_ready() {
        let temp_root = unique_temp_dir("friday-searxng-status-health");
        let resource_root = temp_root.join("resources");
        write_resource_tree(&resource_root);
        let (port, rx, handle) = spawn_ready_server();
        write_valid_settings_file(&temp_root, port);

        let manager = SearXNGManager::new();
        manager.set_app_data_dir(temp_root.join("app"));
        manager.set_resource_dir(resource_root);
        manager.set_host_port(port);

        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        runtime.block_on(async {
            *manager.process.lock().await = Some(ManagedSearxProcess {
                child: spawn_sleep_process(),
                stdout_tail: Arc::new(Mutex::new(String::new())),
                stderr_tail: Arc::new(Mutex::new(String::new())),
            });
            let status = manager.status().await;
            assert_eq!(status.state, WebSearchState::Ready);
            manager.stop().await.expect("stop process");
        });

        assert_eq!(rx.recv().expect("read request path"), "/healthz");
        assert!(rx
            .recv()
            .expect("read request path")
            .starts_with("/search?"));
        handle.join().expect("join server thread");

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn status_reports_port_conflict_when_another_process_owns_the_port() {
        let temp_root = unique_temp_dir("friday-searxng-port-conflict");
        let resource_root = temp_root.join("resources");
        write_resource_tree(&resource_root);

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind conflicting listener");
        let port = listener.local_addr().expect("listener addr").port();

        let manager = SearXNGManager::new();
        manager.set_app_data_dir(temp_root.join("app"));
        manager.set_resource_dir(resource_root);
        manager.set_host_port(port);

        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        let status = runtime.block_on(async { manager.status().await });

        assert_eq!(status.state, WebSearchState::PortConflict);
        assert_eq!(status.message, manager.port_conflict_message());

        drop(listener);
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn stop_process_preserves_non_stopped_lifecycle_state() {
        let temp_root = unique_temp_dir("friday-searxng-stop-process");
        let resource_root = temp_root.join("resources");
        write_resource_tree(&resource_root);

        let manager = SearXNGManager::new();
        manager.set_app_data_dir(temp_root.join("app"));
        manager.set_resource_dir(resource_root);
        manager.set_status(WebSearchStatus::installing(
            "Preparing local web search…",
            manager.base_url(),
        ));

        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        runtime.block_on(async {
            *manager.process.lock().await = Some(ManagedSearxProcess {
                child: spawn_sleep_process(),
                stdout_tail: Arc::new(Mutex::new(String::new())),
                stderr_tail: Arc::new(Mutex::new(String::new())),
            });
            manager
                .stop_process()
                .await
                .expect("stop process without status mutation");
        });

        assert_eq!(
            manager.status.lock().unwrap().state,
            WebSearchState::Installing
        );

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn map_pip_failures_to_product_messages() {
        let output = Output {
            status: exit_status(1),
            stdout: Vec::new(),
            stderr: b"ERROR: No matching distribution found for msgspec".to_vec(),
        };
        assert_eq!(
            map_pip_download_failure(&output),
            "Friday web assist is not yet supported on this platform build."
        );
    }

    #[test]
    fn ensure_local_assets_rewrites_existing_settings_and_preserves_secret() {
        let temp_root = unique_temp_dir("friday-searxng-rewrite");
        let resource_root = temp_root.join("resources");
        write_resource_tree(&resource_root);

        let manager = SearXNGManager::new();
        manager.set_app_data_dir(temp_root.join("app"));
        manager.set_resource_dir(resource_root);
        manager.ensure_local_assets().expect("sync assets");

        let settings_path = temp_root.join("app/searxng/core-config/settings.yml");
        let original = fs::read_to_string(&settings_path).expect("read settings");
        let preserved_secret =
            extract_secret_key_from_settings(&original).expect("extract original secret");

        fs::write(
            &settings_path,
            "server:\n  bind_address: \"0.0.0.0\"\n  port: 8080\n  secret_key: \"legacy-secret\"\n",
        )
        .expect("write legacy settings");

        manager.ensure_local_assets().expect("rewrite settings");

        let rewritten = fs::read_to_string(&settings_path).expect("read rewritten settings");
        assert!(rewritten.contains("bind_address: \"127.0.0.1\""));
        assert!(!rewritten.contains("port: 8080"));
        assert!(rewritten.contains("legacy-secret"));
        assert!(rewritten.contains("use_default_settings: true"));
        assert!(!rewritten.contains(&preserved_secret));

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn ensure_local_assets_removes_legacy_docker_artifacts() {
        let temp_root = unique_temp_dir("friday-searxng-cleanup");
        let resource_root = temp_root.join("resources");
        write_resource_tree(&resource_root);

        let install_root = temp_root.join("app/searxng");
        fs::create_dir_all(&install_root).expect("create install root");
        fs::write(install_root.join(".env"), "SEARXNG_PORT=8080\n").expect("write env");
        fs::write(install_root.join("docker-compose.yml"), "services: {}\n")
            .expect("write compose");

        let manager = SearXNGManager::new();
        manager.set_app_data_dir(temp_root.join("app"));
        manager.set_resource_dir(resource_root);
        manager.ensure_local_assets().expect("sync assets");

        assert!(!install_root.join(".env").exists());
        assert!(!install_root.join("docker-compose.yml").exists());

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn settings_error_logs_map_to_config_error_message() {
        let temp_root = unique_temp_dir("friday-searxng-config-error");
        let resource_root = temp_root.join("resources");
        write_resource_tree(&resource_root);

        let manager = SearXNGManager::new();
        manager.set_app_data_dir(temp_root.join("app"));
        manager.set_resource_dir(resource_root);

        let runtime = tokio::runtime::Runtime::new().expect("create runtime");
        runtime.block_on(async {
            let process = ManagedSearxProcess {
                child: spawn_sleep_process(),
                stdout_tail: Arc::new(Mutex::new(String::new())),
                stderr_tail: Arc::new(Mutex::new(
                    "ValueError: Invalid settings.yml\nExpected `object`, got `null`\n".to_string(),
                )),
            };
            *manager.process.lock().await = Some(process);
            let message = manager.process_start_failure().await;
            assert_eq!(
                message.message(),
                "Local SearXNG config is invalid; Friday could not start local web search."
            );
            manager.stop().await.expect("stop managed process");
        });

        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn generic_start_failure_maps_to_unavailable_status() {
        let status =
            StartupFailure::Generic("Friday could not start local web search.".to_string())
                .into_status("http://127.0.0.1:8091".to_string());

        assert_eq!(status.state, WebSearchState::Unavailable);
        assert!(!status.available);
        assert!(!status.running);
    }

    #[cfg(unix)]
    fn exit_status(code: i32) -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;

        std::process::ExitStatus::from_raw(code)
    }

    fn spawn_sleep_process() -> Child {
        #[cfg(unix)]
        {
            Command::new("sleep")
                .arg("30")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn sleep")
        }

        #[cfg(not(unix))]
        {
            unimplemented!("test helper only supports unix")
        }
    }
}
