# LiteRT-LM Python API Usage Audit

This document reflects the **current** Friday integration after the Python-worker migration.

- Friday target: bundled `LiteRT-LM 0.10.1`
- Friday scope:
  - `src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py`
  - `src-tauri/src/models/python_worker.rs`
  - `src-tauri/src/sidecar.rs`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/settings.rs`
  - frontend files only where they affect the shipped Python-worker flow
- Upstream scope:
  - Official guide: [LiteRT-LM Python guide](https://ai.google.dev/edge/litert-lm/python)
  - Source references: upstream `v0.10.1` Python bindings and interfaces in `google-ai-edge/LiteRT-LM`

## Summary

- **Used in Friday now:** `Engine`, CPU main backend, GPU vision backend, CPU audio backend, `create_conversation(messages=..., tools=..., tool_event_handler=..., extra_context=...)`, streamed `send_message_async`, `cancel_process`, `set_min_log_severity`, multimodal image/audio inputs, streamed `channels["thought"]`, and Python tool callbacks for `web_search`, `web_fetch`, and `calculate`.
- **Partially wired / policy-limited:** Friday still persists `temperature`, `top_p`, and request-side `max_output_tokens` in app settings, but LiteRT-LM's Python conversation API does not consume them in the shipped flow; local file tools exist in the worker but remain disabled for normal chats.
- **Unused in the shipped Python path:** sync `Conversation.send_message`, `Tool`, `tool_from_function`, the low-level `Session` API, `Benchmark`, `BenchmarkInfo`, `cache_dir`, `input_prompt_as_hint`, and `enable_speculative_decoding`.

## Feature Matrix

| Upstream Python API surface | Status | Friday evidence | Upstream reference | Notes |
| --- | --- | --- | --- | --- |
| `Engine(...)` | `used` | `src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py` | [`litert_lm.cc`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/litert_lm.cc) | Friday constructs the Python `Engine` directly in the shipped worker. |
| `Engine.backend` | `used` | `friday_litert_worker.py`, `src-tauri/src/sidecar.rs` | [`interfaces.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/interfaces.py) | Friday runs the main model on `Backend.CPU`. |
| `Engine.max_num_tokens` | `used` | `src-tauri/src/sidecar.rs`, `src-tauri/src/models/python_worker.rs` | [`litert_lm.cc`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/litert_lm.cc) | Friday applies the user token budget when starting or replacing the worker engine. |
| `Engine.vision_backend` | `used` | `friday_litert_worker.py` | [`litert_lm.cc`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/litert_lm.cc) | Friday uses `Backend.GPU` for vision on macOS arm64. |
| `Engine.audio_backend` | `used` | `friday_litert_worker.py` | [`litert_lm.cc`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/litert_lm.cc) | Friday uses `Backend.CPU` for audio. |
| `create_conversation(messages=...)` | `used` | `friday_litert_worker.py` | [`interfaces.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/interfaces.py) | Friday passes system/history turns as conversation preface. |
| `create_conversation(tools=...)` | `used` | `friday_litert_worker.py` | [`getting_started.md`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/docs/api/python/getting_started.md) | The worker registers Python tool callbacks for web search, web fetch, and calculator support. |
| `create_conversation(tool_event_handler=...)` | `used` | `friday_litert_worker.py` | [`interfaces.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/interfaces.py) | Friday emits `tool_call` and `tool_result` worker events through a Python `ToolEventHandler` implementation. |
| `create_conversation(extra_context=...)` | `used` | `friday_litert_worker.py` | [`interfaces.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/interfaces.py) | Friday uses `extra_context={"enable_thinking": ...}` for thinking-capable models. |
| `Conversation.send_message_async(...)` | `used` | `friday_litert_worker.py` | [`interfaces.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/interfaces.py) | Friday's shipped chat path is streaming-first. |
| `Conversation.cancel_process()` | `used` | `friday_litert_worker.py`, `src-tauri/src/models/python_worker.rs` | [`litert_lm.cc`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/litert_lm.cc) | Friday uses cancellation for both user stops and worker shutdown. |
| Streamed `channels["thought"]` | `used` | `friday_litert_worker.py`, `src-tauri/src/lib.rs` | [`litert_lm.cc`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/litert_lm.cc) | Thought tokens are split out and forwarded to the frontend separately from answer tokens. |
| Multi-modal image and audio message parts | `used` | `src-tauri/src/lib.rs`, `src/components/ChatPane.tsx` | [`getting_started.md`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/docs/api/python/getting_started.md) | Friday maps images to `Image { blob }` and audio to `Audio { path }` before sending them to the worker. |
| `ToolEventHandler` | `used` | `friday_litert_worker.py` | [`tools.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/tools.py) | Friday uses a concrete handler class to surface tool lifecycle events back into Rust/UI events. |
| `set_min_log_severity(...)` | `used` | `friday_litert_worker.py` | [`__init__.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/__init__.py), [`getting_started.md`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/docs/api/python/getting_started.md) | Friday lowers LiteRT-LM log noise in the worker process. |
| `temperature` / `top_p` app settings | `partially wired` | `src-tauri/src/settings.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/models/python_worker.rs` | [`interfaces.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/interfaces.py) | Friday stores these settings, but the active Python conversation API does not expose per-request sampling controls in the shipped path. |
| Request-side `generation_config.max_output_tokens` | `partially wired` | `src-tauri/src/settings.rs`, `src-tauri/src/sidecar.rs`, `src-tauri/src/models/python_worker.rs` | [`interfaces.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/interfaces.py) | Friday uses the same user budget as engine-side `max_num_tokens`, but there is no separate per-request max-output hook in the active worker flow. |
| Python local-file tools in shipped chats | `partially wired` | `src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py`, `src-tauri/src/models/python_worker.rs` | [`getting_started.md`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/docs/api/python/getting_started.md) | `file_read` and `list_directory` are implemented in the worker but remain disabled by Friday policy for normal user chats. |
| `Conversation.send_message(...)` | `unused` | Repo-wide absence check across Friday sources; the worker uses only `send_message_async(...)` | [`getting_started.md`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/docs/api/python/getting_started.md), [`interfaces.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/interfaces.py) | Friday's current UX is streaming-only. |
| `Tool` | `unused` | Repo-wide absence check across Friday sources found no `litert_lm.Tool(...)` usage | [`tools.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/tools.py) | Friday passes plain Python callables instead of manually constructing `Tool` objects. |
| `tool_from_function` | `unused` | Repo-wide absence check across Friday sources found no `tool_from_function(...)` usage | [`tools.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/tools.py) | Friday relies on callable registration instead of explicit helper wrapping. |
| Low-level `Session` API: `create_session`, `run_prefill`, `run_decode`, `run_decode_async`, `run_text_scoring` | `unused` | Repo-wide absence check across Friday sources found no LiteRT Python session API usage | [`interfaces.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/interfaces.py), [`litert_lm.cc`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/litert_lm.cc) | Friday stays on the higher-level conversation API. |
| `Benchmark` / `BenchmarkInfo` | `unused` | Repo-wide absence check across Friday sources found no LiteRT Python benchmark usage | [`__init__.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/__init__.py), [`interfaces.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/interfaces.py) | Friday does not use the Python benchmarking surface. |
| `Engine.cache_dir` | `unused` | Repo-wide absence check across Friday sources found no `cache_dir=` passed to `Engine(...)` | [`getting_started.md`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/docs/api/python/getting_started.md), [`litert_lm.cc`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/litert_lm.cc) | Friday relies on the bundled runtime layout instead of a custom Python cache directory. |
| `Engine.input_prompt_as_hint` | `unused` | Repo-wide absence check across Friday sources found no `input_prompt_as_hint=` usage | [`litert_lm.cc`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/litert_lm.cc) | Friday does not use this lower-level engine hint. |
| `Engine.enable_speculative_decoding` | `unused` | Repo-wide absence check across Friday sources found no `enable_speculative_decoding=` usage | [`interfaces.py`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/interfaces.py), [`litert_lm.cc`](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.10.1/python/litert_lm/litert_lm.cc) | Friday does not enable speculative decoding. |

## Current Integration Notes

### 1. The old native-server path is gone

Friday now uses a single shipped inference path:

- Rust sidecar/runtime management in `src-tauri/src/sidecar.rs`
- Rust worker protocol bridge in `src-tauri/src/models/python_worker.rs`
- Python LiteRT-LM worker in `src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py`

The previous Rust `lit serve` integration file `src-tauri/src/models/litert.rs` has been removed from the repo.

### 2. Tool support now comes from the Python worker

Friday now reports native tool support from the active backend status surface and emits tool lifecycle events into the existing frontend listeners.

- Web assist enables `web_search`, `web_fetch`, and `calculate`
- Local file helper tools remain implemented but disabled for user chats
- RAG prompt augmentation now happens in the Rust Python-worker bridge before messages are normalized for the worker

### 3. The image path still depends on Friday's patched macOS arm64 wheel

Friday does not use the stock upstream `0.10.1` wheel unchanged.

- `src-tauri/build.rs`
- `src-tauri/resources/litert-python/PATCHES.md`

Friday's patch keeps Gemma 4 image support working on macOS arm64 when `vision_backend` is configured.

## Verification Notes

- Repo-wide unused classifications were checked across `src`, `src-tauri`, and `scripts`.
- Validation run after the migration:
  - `python3 -m unittest src-tauri/python_tests/test_friday_litert_worker.py`
  - `cargo test --manifest-path src-tauri/Cargo.toml python_worker -- --nocapture`
  - `cargo check --manifest-path src-tauri/Cargo.toml`
