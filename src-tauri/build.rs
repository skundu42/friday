use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const LITERT_LM_VERSION: &str = "0.10.1";

struct RuntimeSpec {
    relative_resource_path: &'static str,
    download_url: &'static str,
}

fn main() {
    println!("cargo:rerun-if-env-changed=FRIDAY_LITERT_RUNTIME_PATH");
    println!("cargo:rerun-if-env-changed=FRIDAY_SKIP_RUNTIME_VENDOR_DOWNLOAD");

    let target_os = env::var("CARGO_CFG_TARGET_OS").expect("missing CARGO_CFG_TARGET_OS");
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").expect("missing CARGO_CFG_TARGET_ARCH");
    let spec = runtime_spec(&target_os, &target_arch).unwrap_or_else(|| {
        panic!(
            "LiteRT-LM native runtime is not available for {} / {}.",
            target_os, target_arch
        )
    });

    println!(
        "cargo:rustc-env=FRIDAY_BUNDLED_LITERT_RESOURCE_PATH={}",
        spec.relative_resource_path
    );

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing manifest dir"));
    let resource_path = manifest_dir
        .join("resources")
        .join(spec.relative_resource_path);
    println!("cargo:rerun-if-changed={}", resource_path.display());

    ensure_bundled_runtime(&resource_path, spec);
    tauri_build::build()
}

fn runtime_spec(target_os: &str, target_arch: &str) -> Option<RuntimeSpec> {
    match (target_os, target_arch) {
        ("macos", "aarch64") => Some(RuntimeSpec {
            relative_resource_path: "litert-runtime/macos-aarch64/lit",
            download_url: "https://github.com/google-ai-edge/LiteRT-LM/releases/download/v0.10.1/lit_macos_arm64",
        }),
        ("linux", "x86_64") => Some(RuntimeSpec {
            relative_resource_path: "litert-runtime/linux-x86_64/lit",
            download_url: "https://github.com/google-ai-edge/LiteRT-LM/releases/download/v0.10.1/lit_linux_x86_64",
        }),
        ("linux", "aarch64") => Some(RuntimeSpec {
            relative_resource_path: "litert-runtime/linux-aarch64/lit",
            download_url: "https://github.com/google-ai-edge/LiteRT-LM/releases/download/v0.10.1/lit_linux_arm64",
        }),
        ("windows", "x86_64") => Some(RuntimeSpec {
            relative_resource_path: "litert-runtime/windows-x86_64/lit.exe",
            download_url: "https://github.com/google-ai-edge/LiteRT-LM/releases/download/v0.10.1/lit_windows_x86_64.exe",
        }),
        _ => None,
    }
}

fn ensure_bundled_runtime(resource_path: &Path, spec: RuntimeSpec) {
    if let Some(local_override) = env::var_os("FRIDAY_LITERT_RUNTIME_PATH") {
        copy_local_runtime(Path::new(&local_override), resource_path);
        return;
    }

    if resource_path.exists() {
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

    download_runtime(spec.download_url, resource_path);
}

fn copy_local_runtime(source_path: &Path, target_path: &Path) {
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
}

fn download_runtime(url: &str, target_path: &Path) {
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
}
