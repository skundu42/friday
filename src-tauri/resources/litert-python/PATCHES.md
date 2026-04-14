Friday bundles a locally patched `litert_lm_api-0.10.1` macOS arm64 wheel.

Patch summary:
- Base source: `google-ai-edge/LiteRT-LM` tag `v0.10.1`
- File patched: `python/litert_lm/litert_lm.cc`
- Change: when `vision_backend` is configured, the Python `Engine(...)` binding now sets `MainExecutorSettings.max_num_images = 4`

Why this exists:
- Upstream LiteRT-LM 0.10.1 disables image slots by default in `LlmExecutorSettings::CreateDefault()`
- Friday's Python conversation worker needs image grounding for Gemma 4
- Friday prefers a GPU main backend and falls back to CPU if warmup fails
- The worker keeps vision on GPU, while audio stays on CPU to satisfy Gemma 4 audio backend constraints

Build note:
- `src-tauri/build.rs` treats this wheel as a vendored artifact
- If the wheel is missing, provide `FRIDAY_LITERT_PYTHON_WHEEL_PATH` with the patched file
