use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const LITERT_LM_VERSION: &str = "0.10.1";
struct RuntimeSpec {
    relative_resource_path: &'static str,
    download_url: &'static str,
    sha256: &'static str,
}

struct PythonRuntimeSpec {
    relative_resource_path: &'static str,
    download_url: &'static str,
    sha256: &'static str,
}

struct PythonWheelSpec {
    relative_resource_path: &'static str,
    sha256: &'static str,
}

const WORKER_SCRIPT_RESOURCE_PATH: &str =
    "litert-python/macos-aarch64/worker/friday_litert_worker.py";

fn main() {
    println!("cargo:rerun-if-env-changed=FRIDAY_LITERT_RUNTIME_PATH");
    println!("cargo:rerun-if-env-changed=FRIDAY_PYTHON_RUNTIME_PATH");
    println!("cargo:rerun-if-env-changed=FRIDAY_LITERT_PYTHON_WHEEL_PATH");
    println!("cargo:rerun-if-env-changed=FRIDAY_SKIP_RUNTIME_VENDOR_DOWNLOAD");

    let target_os = env::var("CARGO_CFG_TARGET_OS").expect("missing CARGO_CFG_TARGET_OS");
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").expect("missing CARGO_CFG_TARGET_ARCH");
    let spec = runtime_spec(&target_os, &target_arch).unwrap_or_else(|| {
        panic!(
            "Friday currently supports the managed LiteRT runtime only on macOS / aarch64, not {} / {}.",
            target_os, target_arch
        )
    });

    println!(
        "cargo:rustc-env=FRIDAY_BUNDLED_LITERT_RESOURCE_PATH={}",
        spec.relative_resource_path
    );
    println!(
        "cargo:rustc-env=FRIDAY_BUNDLED_PYTHON_RUNTIME_RESOURCE_PATH={}",
        python_runtime_spec(&target_os, &target_arch)
            .map(|spec| spec.relative_resource_path)
            .unwrap_or("")
    );
    println!(
        "cargo:rustc-env=FRIDAY_BUNDLED_PYTHON_WHEEL_RESOURCE_PATH={}",
        python_wheel_spec(&target_os, &target_arch)
            .map(|spec| spec.relative_resource_path)
            .unwrap_or("")
    );
    println!(
        "cargo:rustc-env=FRIDAY_BUNDLED_PYTHON_WORKER_RESOURCE_PATH={}",
        if target_os == "macos" && target_arch == "aarch64" {
            WORKER_SCRIPT_RESOURCE_PATH
        } else {
            ""
        }
    );

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing manifest dir"));
    let resource_path = manifest_dir
        .join("resources")
        .join(spec.relative_resource_path);
    println!("cargo:rerun-if-changed={}", resource_path.display());

    ensure_bundled_runtime(&resource_path, spec);

    if let Some(spec) = python_runtime_spec(&target_os, &target_arch) {
        let python_runtime_resource_path = manifest_dir
            .join("resources")
            .join(spec.relative_resource_path);
        println!(
            "cargo:rerun-if-changed={}",
            python_runtime_resource_path.display()
        );
        ensure_bundled_python_runtime(&python_runtime_resource_path, spec);
    }

    if let Some(spec) = python_wheel_spec(&target_os, &target_arch) {
        let python_wheel_resource_path = manifest_dir
            .join("resources")
            .join(spec.relative_resource_path);
        println!(
            "cargo:rerun-if-changed={}",
            python_wheel_resource_path.display()
        );
        ensure_bundled_python_wheel(&python_wheel_resource_path, spec);
    }

    let worker_script_path = manifest_dir
        .join("resources")
        .join(WORKER_SCRIPT_RESOURCE_PATH);
    println!("cargo:rerun-if-changed={}", worker_script_path.display());
    if target_os == "macos" && target_arch == "aarch64" && !worker_script_path.exists() {
        panic!(
            "Bundled Friday LiteRT worker script is missing at {}.",
            worker_script_path.display()
        );
    }

    tauri_build::build()
}

fn runtime_spec(target_os: &str, target_arch: &str) -> Option<RuntimeSpec> {
    match (target_os, target_arch) {
        ("macos", "aarch64") => Some(RuntimeSpec {
            relative_resource_path: "litert-runtime/macos-aarch64/lit",
            download_url: "https://github.com/google-ai-edge/LiteRT-LM/releases/download/v0.10.1/lit_macos_arm64",
            sha256: "311ac22de765402adbba8fb04e4a70d0ed1263ff75d104b063453449651006bb",
        }),
        _ => None,
    }
}

fn python_runtime_spec(target_os: &str, target_arch: &str) -> Option<PythonRuntimeSpec> {
    match (target_os, target_arch) {
        ("macos", "aarch64") => Some(PythonRuntimeSpec {
            relative_resource_path:
                "litert-python/macos-aarch64/cpython-3.12.10+20250521-aarch64-apple-darwin-install_only.tar.gz",
            download_url:
                "https://github.com/astral-sh/python-build-standalone/releases/download/20250521/cpython-3.12.10%2B20250521-aarch64-apple-darwin-install_only.tar.gz",
            sha256: "02d9aa87bd3863a94fd35c215b274e156f946d2d5603127bec77af577ec22a05",
        }),
        _ => None,
    }
}

fn python_wheel_spec(target_os: &str, target_arch: &str) -> Option<PythonWheelSpec> {
    match (target_os, target_arch) {
        // Friday vendors a locally patched LiteRT wheel that enables image
        // slots when a vision backend is configured. Keep the wheel in-repo or
        // provide FRIDAY_LITERT_PYTHON_WHEEL_PATH during the build.
        ("macos", "aarch64") => Some(PythonWheelSpec {
            relative_resource_path:
                "litert-python/macos-aarch64/wheelhouse/litert_lm_api-0.10.1-cp312-cp312-macosx_12_0_arm64.whl",
            sha256: "bd32eb0d7c0c17243e970340ebc96a8f86e68cb9a31c891f5a595297da0c184d",
        }),
        _ => None,
    }
}

fn ensure_bundled_runtime(resource_path: &Path, spec: RuntimeSpec) {
    if let Some(local_override) = env::var_os("FRIDAY_LITERT_RUNTIME_PATH") {
        copy_local_runtime(Path::new(&local_override), resource_path, spec.sha256);
        return;
    }

    if resource_path.exists() {
        verify_runtime_sha256(resource_path, spec.sha256);
        return;
    }

    if env::var("FRIDAY_SKIP_RUNTIME_VENDOR_DOWNLOAD")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        panic!(
            "Bundled LiteRT-LM runtime is missing at {} and automatic vendoring is disabled.",
            resource_path.display()
        );
    }

    download_runtime(spec.download_url, resource_path, spec.sha256);
}

fn ensure_bundled_python_runtime(resource_path: &Path, spec: PythonRuntimeSpec) {
    if let Some(local_override) = env::var_os("FRIDAY_PYTHON_RUNTIME_PATH") {
        copy_local_runtime(Path::new(&local_override), resource_path, spec.sha256);
        return;
    }

    if resource_path.exists() {
        verify_runtime_sha256(resource_path, spec.sha256);
        return;
    }

    if should_skip_vendor_download() {
        panic!(
            "Bundled Python runtime is missing at {} and automatic vendoring is disabled.",
            resource_path.display()
        );
    }

    download_runtime(spec.download_url, resource_path, spec.sha256);
}

fn ensure_bundled_python_wheel(resource_path: &Path, spec: PythonWheelSpec) {
    if let Some(local_override) = env::var_os("FRIDAY_LITERT_PYTHON_WHEEL_PATH") {
        copy_local_runtime(Path::new(&local_override), resource_path, spec.sha256);
        return;
    }

    if resource_path.exists() {
        verify_runtime_sha256(resource_path, spec.sha256);
        return;
    }

    if should_skip_vendor_download() {
        panic!(
            "Bundled LiteRT Python wheel is missing at {} and automatic vendoring is disabled.",
            resource_path.display()
        );
    }

    panic!(
        "Bundled LiteRT Python wheel is missing at {}. Friday ships a locally patched wheel for multimodal support, so restore the vendored file or provide FRIDAY_LITERT_PYTHON_WHEEL_PATH.",
        resource_path.display()
    );
}

fn copy_local_runtime(source_path: &Path, target_path: &Path, expected_sha256: &str) {
    if !source_path.exists() {
        panic!(
            "FRIDAY_LITERT_RUNTIME_PATH points to a missing file: {}",
            source_path.display()
        );
    }

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).expect("failed to create bundled runtime directory");
    }

    fs::copy(source_path, target_path).unwrap_or_else(|error| {
        panic!(
            "Failed to copy LiteRT-LM runtime from {} to {}: {}",
            source_path.display(),
            target_path.display(),
            error
        )
    });
    verify_runtime_sha256(target_path, expected_sha256);
}

fn download_runtime(url: &str, target_path: &Path, expected_sha256: &str) {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).expect("failed to create bundled runtime directory");
    }

    println!(
        "cargo:warning=Vendoring LiteRT-LM {} for bundling from {}",
        LITERT_LM_VERSION, url
    );

    let response = reqwest::blocking::get(url).unwrap_or_else(|error| {
        panic!(
            "Failed to download LiteRT-LM runtime from {}: {}",
            url, error
        )
    });
    if !response.status().is_success() {
        panic!(
            "Failed to download LiteRT-LM runtime from {}: HTTP {}",
            url,
            response.status()
        );
    }

    let bytes = response.bytes().unwrap_or_else(|error| {
        panic!(
            "Failed to read LiteRT-LM runtime response body from {}: {}",
            url, error
        )
    });
    fs::write(target_path, &bytes).unwrap_or_else(|error| {
        panic!(
            "Failed to write bundled LiteRT-LM runtime to {}: {}",
            target_path.display(),
            error
        )
    });
    verify_runtime_sha256(target_path, expected_sha256);
}

fn should_skip_vendor_download() -> bool {
    env::var("FRIDAY_SKIP_RUNTIME_VENDOR_DOWNLOAD")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn verify_runtime_sha256(path: &Path, expected_sha256: &str) {
    let bytes = fs::read(path).unwrap_or_else(|error| {
        panic!(
            "Failed to read LiteRT-LM runtime from {} for checksum verification: {}",
            path.display(),
            error
        )
    });
    let actual_sha256 = format!("{:x}", Sha256::digest(&bytes));
    if actual_sha256 != expected_sha256 {
        panic!(
            "LiteRT-LM runtime checksum mismatch for {}. Expected {}, got {}.",
            path.display(),
            expected_sha256,
            actual_sha256
        );
    }
}
