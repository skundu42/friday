use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct EmbeddedPythonPaths {
    pub python_binary: PathBuf,
    pub python_lib_dir: PathBuf,
}

pub fn ensure_embedded_python_runtime(
    app_data_dir: &Path,
    resource_dir: &Path,
    runtime_version: &str,
    bundled_python_runtime_relative_path: &str,
) -> Result<EmbeddedPythonPaths, String> {
    if bundled_python_runtime_relative_path.trim().is_empty() {
        return Err("Friday web assist is not yet supported on this platform build.".to_string());
    }

    let runtime_dir = app_data_dir
        .join("litert-runtime")
        .join(runtime_version)
        .join("python");
    let python_binary = runtime_dir.join("bin").join("python3");
    let python_lib_dir = runtime_dir.join("lib");

    let source_path =
        bundled_resource_source_path(resource_dir, bundled_python_runtime_relative_path);
    if !source_path.exists() {
        return Err(format!(
            "Bundled Friday Python runtime asset is missing at {}. Rebuild the app so the runtime is packaged.",
            source_path.display()
        ));
    }

    install_python_runtime_archive(&source_path, &runtime_dir)?;

    Ok(EmbeddedPythonPaths {
        python_binary,
        python_lib_dir,
    })
}

pub fn bundled_resource_source_path(resource_dir: &Path, relative_path: &str) -> PathBuf {
    let primary = resource_dir.join(relative_path);
    if primary.exists() {
        return primary;
    }

    let legacy = resource_dir.join("resources").join(relative_path);
    if legacy.exists() {
        return legacy;
    }

    primary
}

pub fn install_python_runtime_archive(source_path: &Path, target_dir: &Path) -> Result<(), String> {
    if target_dir.join("bin").join("python3").exists() {
        return Ok(());
    }

    let staging_dir = target_dir.with_extension("staging");
    if staging_dir.exists() {
        let _ = std::fs::remove_dir_all(&staging_dir);
    }
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create Python staging directory: {}", e))?;

    let archive_file = std::fs::File::open(source_path).map_err(|e| {
        format!(
            "Failed to open bundled Python runtime archive {}: {}",
            source_path.display(),
            e
        )
    })?;
    let decoder = flate2::read::GzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(&staging_dir)
        .map_err(|e| format!("Failed to unpack bundled Python runtime: {}", e))?;

    let extracted_dir = staging_dir.join("python");
    if !extracted_dir.exists() {
        return Err(format!(
            "Bundled Python runtime archive {} did not contain a top-level python directory.",
            source_path.display()
        ));
    }

    if target_dir.exists() {
        let _ = std::fs::remove_dir_all(target_dir);
    }
    std::fs::rename(&extracted_dir, target_dir)
        .map_err(|e| format!("Failed to finalize bundled Python runtime install: {}", e))?;
    let _ = std::fs::remove_dir_all(&staging_dir);
    Ok(())
}

pub fn sync_file_if_changed(
    source_path: &Path,
    target_path: &Path,
    executable: bool,
) -> Result<bool, String> {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    let needs_update = match std::fs::metadata(target_path) {
        Ok(target_metadata) => {
            let source_metadata = std::fs::metadata(source_path).map_err(|e| {
                format!(
                    "Failed to read bundled asset metadata {}: {}",
                    source_path.display(),
                    e
                )
            })?;

            if source_metadata.len() != target_metadata.len() {
                true
            } else {
                let source_bytes = std::fs::read(source_path).map_err(|e| {
                    format!(
                        "Failed to read bundled asset {}: {}",
                        source_path.display(),
                        e
                    )
                })?;
                let target_bytes = std::fs::read(target_path).map_err(|e| {
                    format!(
                        "Failed to read installed asset {}: {}",
                        target_path.display(),
                        e
                    )
                })?;
                source_bytes != target_bytes
            }
        }
        Err(_) => true,
    };

    #[cfg(unix)]
    let desired_permissions =
        std::fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 });

    if !needs_update {
        #[cfg(unix)]
        {
            std::fs::set_permissions(target_path, desired_permissions).map_err(|e| {
                format!(
                    "Failed to update installed asset permissions {}: {}",
                    target_path.display(),
                    e
                )
            })?;
        }
        return Ok(false);
    }

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create installed asset directory {}: {}",
                parent.display(),
                e
            )
        })?;
    }

    let temp_path = target_path.with_extension("part");
    if temp_path.exists() {
        let _ = std::fs::remove_file(&temp_path);
    }
    std::fs::copy(source_path, &temp_path).map_err(|e| {
        format!(
            "Failed to copy bundled asset {}: {}",
            source_path.display(),
            e
        )
    })?;

    #[cfg(unix)]
    {
        std::fs::set_permissions(&temp_path, desired_permissions).map_err(|e| {
            format!(
                "Failed to update staged asset permissions {}: {}",
                temp_path.display(),
                e
            )
        })?;
    }

    std::fs::rename(&temp_path, target_path).map_err(|e| {
        format!(
            "Failed to finalize bundled asset install {}: {}",
            target_path.display(),
            e
        )
    })?;

    Ok(true)
}

pub fn install_python_wheel(source_path: &Path, target_dir: &Path) -> Result<(), String> {
    let staging_dir = target_dir.with_extension("staging");
    if staging_dir.exists() {
        let _ = std::fs::remove_dir_all(&staging_dir);
    }
    std::fs::create_dir_all(&staging_dir).map_err(|e| {
        format!(
            "Failed to create Python site-packages staging directory: {}",
            e
        )
    })?;

    let file = std::fs::File::open(source_path).map_err(|e| {
        format!(
            "Failed to open bundled LiteRT Python wheel {}: {}",
            source_path.display(),
            e
        )
    })?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read Python wheel: {}", e))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Failed to read Python wheel entry: {}", e))?;
        let Some(enclosed_name) = entry.enclosed_name().map(Path::to_path_buf) else {
            continue;
        };
        let output_path = staging_dir.join(enclosed_name);
        if entry.name().ends_with('/') {
            std::fs::create_dir_all(&output_path)
                .map_err(|e| format!("Failed to create Python wheel directory: {}", e))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create Python wheel parent directory: {}", e))?;
        }

        let mut output_file = std::fs::File::create(&output_path)
            .map_err(|e| format!("Failed to create Python wheel file: {}", e))?;
        std::io::copy(&mut entry, &mut output_file)
            .map_err(|e| format!("Failed to extract Python wheel file: {}", e))?;
    }

    if target_dir.exists() {
        let _ = std::fs::remove_dir_all(target_dir);
    }
    std::fs::rename(&staging_dir, target_dir)
        .map_err(|e| format!("Failed to finalize Python wheel install: {}", e))?;
    Ok(())
}

pub fn sha256_bytes_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn sha256_file_hex(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
    Ok(sha256_bytes_hex(&bytes))
}
