#[path = "src/runtime_manifest.rs"]
mod runtime_manifest;

use runtime_manifest::{load_runtime_manifest_from_path, source_manifest_path, RuntimeAssetSpec};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=FRIDAY_LITERT_RUNTIME_PATH");
    println!("cargo:rerun-if-env-changed=FRIDAY_PYTHON_RUNTIME_PATH");
    println!("cargo:rerun-if-env-changed=FRIDAY_LITERT_PYTHON_WHEEL_PATH");
    println!("cargo:rerun-if-env-changed=FRIDAY_SKIP_RUNTIME_VENDOR_DOWNLOAD");

    let target_os = env::var("CARGO_CFG_TARGET_OS").expect("missing CARGO_CFG_TARGET_OS");
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").expect("missing CARGO_CFG_TARGET_ARCH");
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing manifest dir"));
    let runtime_manifest_path = source_manifest_path(&manifest_dir);
    println!("cargo:rerun-if-changed={}", runtime_manifest_path.display());

    let manifest = load_runtime_manifest_from_path(&runtime_manifest_path)
        .unwrap_or_else(|error| panic!("{}", error));
    let platform = manifest
        .platform_for_target(&target_os, &target_arch)
        .unwrap_or_else(|error| panic!("{}", error));
    let resource_root = manifest_dir.join("resources");

    let litert_binary_path = platform.litert_binary.source_path(&resource_root);
    println!("cargo:rerun-if-changed={}", litert_binary_path.display());
    ensure_bundled_downloadable_asset(
        &litert_binary_path,
        &platform.litert_binary,
        "FRIDAY_LITERT_RUNTIME_PATH",
        "Bundled LiteRT-LM runtime",
        "LiteRT-LM runtime",
        &platform.runtime_version,
    );

    let python_runtime_archive_path = platform.python_runtime_archive.source_path(&resource_root);
    println!(
        "cargo:rerun-if-changed={}",
        python_runtime_archive_path.display()
    );
    ensure_bundled_downloadable_asset(
        &python_runtime_archive_path,
        &platform.python_runtime_archive,
        "FRIDAY_PYTHON_RUNTIME_PATH",
        "Bundled Python runtime",
        "Python runtime",
        &platform.runtime_version,
    );

    let python_wheel_path = platform.python_wheel.source_path(&resource_root);
    println!("cargo:rerun-if-changed={}", python_wheel_path.display());
    ensure_bundled_python_wheel(&python_wheel_path, &platform.python_wheel);

    let worker_script_path = platform.worker_script.source_path(&resource_root);
    println!("cargo:rerun-if-changed={}", worker_script_path.display());
    if !worker_script_path.exists() {
        panic!(
            "Bundled Friday LiteRT worker script is missing at {}.",
            worker_script_path.display()
        );
    }

    tauri_build::build()
}

fn ensure_bundled_downloadable_asset(
    resource_path: &Path,
    asset: &RuntimeAssetSpec,
    local_override_env: &str,
    asset_name: &str,
    download_label: &str,
    version_label: &str,
) {
    let expected_sha256 = asset
        .sha256_required(asset_name)
        .unwrap_or_else(|error| panic!("{}", error));

    if let Some(local_override) = env::var_os(local_override_env) {
        copy_local_asset(
            Path::new(&local_override),
            resource_path,
            expected_sha256,
            local_override_env,
            asset_name,
        );
        return;
    }

    if resource_path.exists() {
        verify_asset_sha256(resource_path, expected_sha256, asset_name);
        return;
    }

    if should_skip_vendor_download() {
        panic!(
            "{} is missing at {} and automatic vendoring is disabled.",
            asset_name,
            resource_path.display()
        );
    }

    let download_url = asset
        .download_url_required(asset_name)
        .unwrap_or_else(|error| panic!("{}", error));
    download_asset(
        download_url,
        resource_path,
        expected_sha256,
        asset_name,
        download_label,
        version_label,
    );
}

fn ensure_bundled_python_wheel(resource_path: &Path, asset: &RuntimeAssetSpec) {
    let asset_name = "Bundled LiteRT Python wheel";
    let expected_sha256 = asset
        .sha256_required(asset_name)
        .unwrap_or_else(|error| panic!("{}", error));

    if let Some(local_override) = env::var_os("FRIDAY_LITERT_PYTHON_WHEEL_PATH") {
        copy_local_asset(
            Path::new(&local_override),
            resource_path,
            expected_sha256,
            "FRIDAY_LITERT_PYTHON_WHEEL_PATH",
            asset_name,
        );
        return;
    }

    if resource_path.exists() {
        verify_asset_sha256(resource_path, expected_sha256, asset_name);
        return;
    }

    if should_skip_vendor_download() {
        panic!(
            "{} is missing at {} and automatic vendoring is disabled.",
            asset_name,
            resource_path.display()
        );
    }

    panic!(
        "{} is missing at {}. Friday ships a locally patched wheel for multimodal support, so restore the vendored file or provide FRIDAY_LITERT_PYTHON_WHEEL_PATH.",
        asset_name,
        resource_path.display()
    );
}

fn copy_local_asset(
    source_path: &Path,
    target_path: &Path,
    expected_sha256: &str,
    local_override_env: &str,
    asset_name: &str,
) {
    if !source_path.exists() {
        panic!(
            "{} points to a missing file: {}",
            local_override_env,
            source_path.display()
        );
    }

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).expect("failed to create bundled runtime directory");
    }

    fs::copy(source_path, target_path).unwrap_or_else(|error| {
        panic!(
            "Failed to copy {} from {} to {}: {}",
            asset_name,
            source_path.display(),
            target_path.display(),
            error
        )
    });
    verify_asset_sha256(target_path, expected_sha256, asset_name);
}

fn download_asset(
    url: &str,
    target_path: &Path,
    expected_sha256: &str,
    asset_name: &str,
    download_label: &str,
    version_label: &str,
) {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).expect("failed to create bundled runtime directory");
    }

    println!(
        "cargo:warning=Vendoring {} {} for bundling from {}",
        download_label, version_label, url
    );

    let response = reqwest::blocking::get(url).unwrap_or_else(|error| {
        panic!("Failed to download {} from {}: {}", asset_name, url, error)
    });
    if !response.status().is_success() {
        panic!(
            "Failed to download {} from {}: HTTP {}",
            asset_name,
            url,
            response.status()
        );
    }

    let bytes = response.bytes().unwrap_or_else(|error| {
        panic!(
            "Failed to read {} response body from {}: {}",
            asset_name, url, error
        )
    });
    fs::write(target_path, &bytes).unwrap_or_else(|error| {
        panic!(
            "Failed to write {} to {}: {}",
            asset_name,
            target_path.display(),
            error
        )
    });
    verify_asset_sha256(target_path, expected_sha256, asset_name);
}

fn should_skip_vendor_download() -> bool {
    env::var("FRIDAY_SKIP_RUNTIME_VENDOR_DOWNLOAD")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn verify_asset_sha256(path: &Path, expected_sha256: &str, asset_name: &str) {
    let bytes = fs::read(path).unwrap_or_else(|error| {
        panic!(
            "Failed to read {} from {} for checksum verification: {}",
            asset_name,
            path.display(),
            error
        )
    });
    let actual_sha256 = format!("{:x}", Sha256::digest(&bytes));
    if actual_sha256 != expected_sha256 {
        panic!(
            "{} checksum mismatch for {}. Expected {}, got {}.",
            asset_name,
            path.display(),
            expected_sha256,
            actual_sha256
        );
    }
}
