This directory is populated with the platform-specific LiteRT-LM runtime that Friday bundles into the app.

Expected paths:

- `litert-runtime/macos-aarch64/lit`
- `litert-runtime/linux-x86_64/lit`
- `litert-runtime/linux-aarch64/lit`
- `litert-runtime/windows-x86_64/lit.exe`

Build behavior:

- If `FRIDAY_LITERT_RUNTIME_PATH` is set, `src-tauri/build.rs` copies that file into the matching path above.
- Otherwise, `src-tauri/build.rs` downloads the correct runtime from the official LiteRT-LM release assets if it is missing.
- Set `FRIDAY_SKIP_RUNTIME_VENDOR_DOWNLOAD=1` to fail the build instead of auto-downloading.
