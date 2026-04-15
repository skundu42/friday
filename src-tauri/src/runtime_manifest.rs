#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

pub const RUNTIME_MANIFEST_RESOURCE_PATH: &str = "litert-runtime/runtime-manifest.json";

const EMBEDDED_RUNTIME_MANIFEST_JSON: &str =
    include_str!("../resources/litert-runtime/runtime-manifest.json");
const SUPPORTED_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeManifest {
    pub schema_version: u32,
    pub platforms: Vec<PlatformRuntimeSpec>,
    pub models: Vec<RuntimeModelSpec>,
    pub policy: RuntimePolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlatformRuntimeSpec {
    pub target_os: String,
    pub target_arch: String,
    pub runtime_version: String,
    pub python_worker_binary_name: String,
    pub litert_binary: RuntimeAssetSpec,
    pub python_runtime_archive: RuntimeAssetSpec,
    pub python_wheel: RuntimeAssetSpec,
    pub worker_script: RuntimeAssetSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeAssetSpec {
    pub relative_resource_path: String,
    #[serde(default)]
    pub download_url: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimePolicy {
    pub default_backend: String,
    pub high_ram_default_model_threshold_gb: f64,
    pub daemon_idle_timeout_secs: u64,
    pub daemon_idle_check_interval_secs: u64,
    pub process_output_tail_limit_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RuntimeModelSpec {
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

pub fn source_manifest_path(manifest_dir: &Path) -> PathBuf {
    manifest_dir
        .join("resources")
        .join(RUNTIME_MANIFEST_RESOURCE_PATH)
}

pub fn load_runtime_manifest_from_path(path: &Path) -> Result<RuntimeManifest, String> {
    let bytes = std::fs::read_to_string(path).map_err(|error| {
        format!(
            "Failed to read runtime manifest {}: {}",
            path.display(),
            error
        )
    })?;
    parse_runtime_manifest(&bytes, &path.display().to_string())
}

pub fn embedded_runtime_manifest() -> Result<&'static RuntimeManifest, String> {
    static MANIFEST: OnceLock<Result<RuntimeManifest, String>> = OnceLock::new();
    match MANIFEST.get_or_init(|| {
        parse_runtime_manifest(EMBEDDED_RUNTIME_MANIFEST_JSON, "embedded runtime manifest")
    }) {
        Ok(manifest) => Ok(manifest),
        Err(error) => Err(error.clone()),
    }
}

pub fn unsupported_platform_error(target_os: &str, target_arch: &str) -> String {
    format!(
        "Friday currently supports the managed LiteRT runtime only on macOS / aarch64, not {} / {}.",
        target_os, target_arch
    )
}

impl RuntimeManifest {
    pub fn platform_for_target(
        &self,
        target_os: &str,
        target_arch: &str,
    ) -> Result<&PlatformRuntimeSpec, String> {
        self.platforms
            .iter()
            .find(|platform| platform.target_os == target_os && platform.target_arch == target_arch)
            .ok_or_else(|| unsupported_platform_error(target_os, target_arch))
    }

    pub fn platform_for_current_target(&self) -> Result<&PlatformRuntimeSpec, String> {
        self.platform_for_target(std::env::consts::OS, std::env::consts::ARCH)
    }

    pub fn model_by_id(&self, id: &str) -> Option<&RuntimeModelSpec> {
        self.models.iter().find(|model| model.id == id)
    }

    pub fn default_model_for_ram_gb(&self, total_ram_gb: f64) -> Option<&RuntimeModelSpec> {
        if total_ram_gb > self.policy.high_ram_default_model_threshold_gb {
            self.models
                .iter()
                .max_by(|left, right| compare_model_default_priority(left, right))
        } else {
            self.models
                .iter()
                .min_by(|left, right| compare_model_default_priority(left, right))
        }
    }
}

impl RuntimeAssetSpec {
    pub fn source_path(&self, resource_root: &Path) -> PathBuf {
        resource_root.join(&self.relative_resource_path)
    }

    pub fn file_name(&self, asset_name: &str) -> Result<&str, String> {
        Path::new(&self.relative_resource_path)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                format!(
                    "{} is missing a valid file name in runtime-manifest.json.",
                    asset_name
                )
            })
    }

    pub fn download_url_required(&self, asset_name: &str) -> Result<&str, String> {
        self.download_url.as_deref().ok_or_else(|| {
            format!(
                "{} is missing its download URL in runtime-manifest.json.",
                asset_name
            )
        })
    }

    pub fn sha256_required(&self, asset_name: &str) -> Result<&str, String> {
        self.sha256.as_deref().ok_or_else(|| {
            format!(
                "{} is missing its SHA256 checksum in runtime-manifest.json.",
                asset_name
            )
        })
    }
}

impl RuntimePolicy {
    pub fn daemon_idle_timeout(&self) -> Duration {
        Duration::from_secs(self.daemon_idle_timeout_secs)
    }

    pub fn daemon_idle_check_interval(&self) -> Duration {
        Duration::from_secs(self.daemon_idle_check_interval_secs)
    }
}

fn parse_runtime_manifest(raw: &str, source: &str) -> Result<RuntimeManifest, String> {
    let manifest: RuntimeManifest = serde_json::from_str(raw)
        .map_err(|error| format!("Failed to parse runtime manifest {}: {}", source, error))?;
    validate_runtime_manifest(&manifest)?;
    Ok(manifest)
}

fn validate_runtime_manifest(manifest: &RuntimeManifest) -> Result<(), String> {
    if manifest.schema_version != SUPPORTED_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported runtime manifest schema version {}. Expected {}.",
            manifest.schema_version, SUPPORTED_SCHEMA_VERSION
        ));
    }

    if manifest.platforms.is_empty() {
        return Err("Runtime manifest must include at least one supported platform.".to_string());
    }
    if manifest.models.is_empty() {
        return Err("Runtime manifest must include at least one model.".to_string());
    }

    let mut platform_keys = std::collections::BTreeSet::new();
    for platform in &manifest.platforms {
        let key = format!("{}/{}", platform.target_os, platform.target_arch);
        if !platform_keys.insert(key.clone()) {
            return Err(format!(
                "Duplicate runtime platform entry found for {}.",
                key
            ));
        }
        if platform.runtime_version.trim().is_empty() {
            return Err(format!(
                "Runtime platform {} is missing its runtime version.",
                key
            ));
        }
        if platform.python_worker_binary_name.trim().is_empty() {
            return Err(format!(
                "Runtime platform {} is missing its python worker binary name.",
                key
            ));
        }
        validate_asset(&platform.litert_binary, "LiteRT runtime", true, true)?;
        validate_asset(
            &platform.python_runtime_archive,
            "Embedded Python runtime",
            true,
            true,
        )?;
        validate_asset(&platform.python_wheel, "LiteRT Python wheel", false, true)?;
        validate_asset(
            &platform.worker_script,
            "Python worker script",
            false,
            false,
        )?;
    }

    let mut model_ids = std::collections::BTreeSet::new();
    for model in &manifest.models {
        if !model_ids.insert(model.id.clone()) {
            return Err(format!(
                "Duplicate runtime model entry found for {}.",
                model.id
            ));
        }
        if model.id.trim().is_empty()
            || model.repo.trim().is_empty()
            || model.filename.trim().is_empty()
            || model.display_name.trim().is_empty()
        {
            return Err(
                "Runtime manifest model entries must include id, repo, filename, and display_name."
                    .to_string(),
            );
        }
    }

    if manifest.policy.default_backend.trim().is_empty() {
        return Err("Runtime manifest policy is missing default_backend.".to_string());
    }

    Ok(())
}

fn validate_asset(
    asset: &RuntimeAssetSpec,
    asset_name: &str,
    require_download_url: bool,
    require_sha256: bool,
) -> Result<(), String> {
    if asset.relative_resource_path.trim().is_empty() {
        return Err(format!(
            "{} is missing its relative_resource_path in runtime-manifest.json.",
            asset_name
        ));
    }
    if require_download_url {
        let _ = asset.download_url_required(asset_name)?;
    }
    if require_sha256 {
        let _ = asset.sha256_required(asset_name)?;
    }
    Ok(())
}

fn compare_model_default_priority(left: &RuntimeModelSpec, right: &RuntimeModelSpec) -> Ordering {
    left.min_ram_gb
        .partial_cmp(&right.min_ram_gb)
        .unwrap_or(Ordering::Equal)
        .then_with(|| left.id.cmp(&right.id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_manifest_supports_current_macos_arm64_target() {
        let manifest = embedded_runtime_manifest().expect("embedded runtime manifest");
        let platform = manifest
            .platform_for_target("macos", "aarch64")
            .expect("macos arm64 platform");

        assert_eq!(platform.runtime_version, "0.10.1");
        assert_eq!(platform.python_worker_binary_name, "friday-worker");
        assert_eq!(
            platform.litert_binary.relative_resource_path,
            "litert-runtime/macos-aarch64/lit"
        );
    }

    #[test]
    fn unsupported_platform_lookup_returns_controlled_error() {
        let manifest = embedded_runtime_manifest().expect("embedded runtime manifest");
        let error = manifest
            .platform_for_target("linux", "x86_64")
            .expect_err("unsupported target should fail");

        assert!(error.contains("managed LiteRT runtime only on macOS / aarch64"));
    }

    #[test]
    fn embedded_manifest_contains_current_model_ids() {
        let manifest = embedded_runtime_manifest().expect("embedded runtime manifest");
        assert!(manifest.model_by_id("gemma-4-e2b-it").is_some());
        assert!(manifest.model_by_id("gemma-4-e4b-it").is_some());
    }

    #[test]
    fn manifest_platform_assets_preserve_expected_checksums_and_paths() {
        let manifest = embedded_runtime_manifest().expect("embedded runtime manifest");
        let platform = manifest
            .platform_for_target("macos", "aarch64")
            .expect("macos arm64 platform");

        assert_eq!(
            platform
                .litert_binary
                .sha256_required("LiteRT runtime")
                .expect("runtime sha"),
            "311ac22de765402adbba8fb04e4a70d0ed1263ff75d104b063453449651006bb"
        );
        assert_eq!(
            platform
                .python_runtime_archive
                .sha256_required("Embedded Python runtime")
                .expect("python runtime sha"),
            "02d9aa87bd3863a94fd35c215b274e156f946d2d5603127bec77af577ec22a05"
        );
        assert_eq!(
            platform
                .python_wheel
                .relative_resource_path,
            "litert-python/macos-aarch64/wheelhouse/litert_lm_api-0.10.1-cp312-cp312-macosx_12_0_arm64.whl"
        );
    }

    #[test]
    fn platform_asset_helpers_resolve_expected_paths_and_filenames() {
        let manifest = embedded_runtime_manifest().expect("embedded runtime manifest");
        let platform = manifest
            .platform_for_target("macos", "aarch64")
            .expect("macos arm64 platform");
        let resource_root = Path::new("/tmp/friday-test-resources");

        assert_eq!(
            platform
                .litert_binary
                .source_path(resource_root)
                .to_string_lossy(),
            "/tmp/friday-test-resources/litert-runtime/macos-aarch64/lit"
        );
        assert_eq!(
            platform
                .litert_binary
                .file_name("LiteRT runtime")
                .expect("runtime file name"),
            "lit"
        );
        assert_eq!(
            platform
                .worker_script
                .file_name("Python worker script")
                .expect("worker script file name"),
            "friday_litert_worker.py"
        );
    }
}
