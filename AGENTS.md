# AGENTS.md - Friday Codebase Reference

## Product Snapshot

Friday is a local-first desktop AI assistant built with Tauri 2, Rust, React 19, and LiteRT-LM. The app runs Gemma 4 models on-device through a managed LiteRT runtime that Friday installs, warms, and shuts down itself.

Current user-facing app capabilities:

- Streaming local chat with persistent sessions
- Automatic chat titles derived from the first user message while new chats still start as `New chat`
- First-run setup wizard with display-name capture and model download progress
- Responsive layout with a docked sidebar on wide screens and a drawer-based sidebar on narrow screens
- File attachments in chat, including text/code files, PDFs, DOCX, images, and audio
- Microphone recording for audio prompts when the environment supports `MediaRecorder`
- Model management for `Gemma 4 E2B` and `Gemma 4 E4B`
- Reply language control for English, Hindi, Bengali, Marathi, Tamil, and Punjabi
- Optional thinking mode for supported models
- Assistant reasoning disclosure UI for replies that include thinking content
- Assistant answer rendering with GitHub-flavored Markdown, copyable code blocks, and KaTeX math
- Optional web-assisted replies via the chat composer
- Friday-managed localhost SearXNG provisioning and startup for web search on first web-assisted use
- Connection/privacy status pills and inline tool-activity status text during assisted replies
- Settings for token budget, reply language, model downloads/switching, and startup pre-warming

Current backend-only or partially surfaced capabilities:

- RAG ingestion and search commands exist in the backend
- Prompt-time RAG augmentation exists, but RAG is disabled by default and not wired to a dedicated UI
- The shipped LiteRT-LM Python worker exposes `get_current_datetime`, `web_search`, `web_fetch`, `file_read`, `list_directory`, and `calculate`
- In the shipped chat flow, `get_current_datetime` is always enabled and web assist additionally enables `web_search`, `web_fetch`, and `calculate`; local file helper tools remain disabled for user chats
- Local observability logs are written to `app_data/logs/friday.log`, but there is no dedicated log viewer UI

Privacy note:

- Inference, sessions, settings, and local files stay on-device by default
- First-run setup downloads the native LiteRT runtime assets and model files from the network when the bundle is incomplete
- If the user enables web-assisted replies, Friday downloads the pinned local SearXNG dependencies on first use and can then send search/fetch requests to external sites

## Current Platform Support

Friday's managed runtime flow currently supports macOS Apple Silicon only.

- `src-tauri/build.rs` only defines LiteRT runtime, bundled CPython runtime, and patched wheel specs for `macos/aarch64`
- the shipped worker script path is also wired for `macos/aarch64`
- treat Apple Silicon as the supported build and packaging target until additional target specs are added

## Stack

Frontend:

- React 19
- TypeScript
- Vite 6
- Ant Design 5
- `@tauri-apps/api` v2
- `@tauri-apps/plugin-dialog` v2
- `react-markdown`
- `remark-gfm`
- `remark-math`
- `rehype-katex`
- `katex`
- Vitest + Testing Library

Backend:

- Tauri 2
- Rust 2021
- `rusqlite` with bundled SQLite
- `reqwest`
- `tokio`
- `serde` / `serde_json`
- `uuid`
- `chrono`
- `sysinfo`
- `tracing` / `tracing-subscriber`
- `pdf-extract`
- `zip`
- `flate2`
- `tar`
- `base64`
- `sha2`
- `meval`

Inference/runtime:

- LiteRT-LM `0.10.1`
- managed native LiteRT runtime via bundled `lit` release assets
- embedded CPython `3.12.10`
- locally patched `litert_lm_api` wheel for Gemma 4 image slots

## Model Registry

The app currently ships a small local model registry in [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs).

- `gemma-4-e2b-it`
  - Display name: `Gemma 4 E2B`
  - File: `gemma-4-E2B-it.litertlm`
  - Download: about `2.41 GB`
  - Minimum RAM: `4 GB`
  - Context window: `131,072`
  - Recommended max output: `4,096`
  - Capabilities: image input, audio input, thinking
- `gemma-4-e4b-it`
  - Display name: `Gemma 4 E4B`
  - File: `gemma-4-E4B-it.litertlm`
  - Download: about `3.40 GB`
  - Minimum RAM: `8 GB`
  - Context window: `131,072`
  - Recommended max output: `8,192`
  - Capabilities: image input, audio input, thinking

Friday defaults to `Gemma 4 E2B` on most systems and to `Gemma 4 E4B` on systems with more than `16 GB` RAM.

## Repository Layout

```text
daksha-ai/
├── AGENTS.md
├── README.md
├── vite.config.ts
├── package.json
├── .github/
│   └── workflows/
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── styles.css
│   ├── types.ts
│   ├── test/
│   ├── components/
│   ├── hooks/
│   └── theme/
└── src-tauri/
    ├── build.rs
    ├── Cargo.toml
    ├── resources/
    ├── tauri.conf.json
    ├── migrations/
    ├── python_tests/
    └── src/
```

Key files:

- [`src/App.tsx`](src/App.tsx): top-level layout, setup gating, sidebar/drawer behavior, settings/chat split
- [`src/hooks/useAppController.ts`](src/hooks/useAppController.ts): frontend state hub, bootstrapping, event listeners, model inventory, send/cancel flow, startup warmup
- [`src/components/ChatPane.tsx`](src/components/ChatPane.tsx): chat UI, attachments, web/thinking toggles, microphone recording
- [`src/components/MessageBubble.tsx`](src/components/MessageBubble.tsx): assistant Markdown rendering, reasoning disclosure UI, code-copy actions, KaTeX math
- [`src/components/SettingsPanel.tsx`](src/components/SettingsPanel.tsx): reply language, token presets, model downloads/switching, startup pre-warm toggle
- [`src/components/SetupWizard.tsx`](src/components/SetupWizard.tsx): first-run onboarding and model download flow
- [`src/test/setup.ts`](src/test/setup.ts): shared Vitest/jsdom test shims
- [`vite.config.ts`](vite.config.ts): Vite build config, test environment, and vendor chunk strategy
- [`src-tauri/build.rs`](src-tauri/build.rs): build-time LiteRT and Python asset vendoring plus resource path env wiring
- [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs): Tauri commands, app state, prompt assembly, persistence flow, streaming event emission, log initialization
- [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs): runtime bootstrap, model downloads, native runtime lifecycle, model registry, warmup
- [`src-tauri/src/python_runtime.rs`](src-tauri/src/python_runtime.rs): embedded CPython install/sync helpers
- [`src-tauri/src/searxng.rs`](src-tauri/src/searxng.rs): local SearXNG provisioning, process management, health checks, and web-search status
- [`src-tauri/src/models/python_worker.rs`](src-tauri/src/models/python_worker.rs): Rust bridge to the bundled Friday LiteRT-LM Python worker
- [`src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py`](src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py): shipped LiteRT-LM Python worker, tool hooks, streaming logic, and SearXNG-backed web search
- [`src-tauri/resources/searxng/`](src-tauri/resources/searxng/): vendored Friday-owned SearXNG config, source manifest, and dependency lockfile templates
- [`src-tauri/src/rag/mod.rs`](src-tauri/src/rag/mod.rs): Rust-owned RAG ingestion and search
- [`src-tauri/src/settings.rs`](src-tauri/src/settings.rs): settings schema, defaults, validation
- [`src-tauri/src/storage/mod.rs`](src-tauri/src/storage/mod.rs): SQLite init and setting helpers

## Runtime And Data Paths

Friday uses the platform app-data directory. On macOS the identifier is `com.friday.app`.

Important subdirectories:

- `app_data/friday.db`
- `app_data/logs/friday.log`
- `app_data/models/`
- `app_data/litert-runtime/`
- `app_data/lit-home/`
- `app_data/lit-home/models/<model-id>/model.litertlm`
- `app_data/searxng/`
- `app_data/temp/`
- `app_data/rag/`

Notes:

- The backend still creates `app_data/models/` during setup, but the managed LiteRT runtime currently stores downloaded model files under `app_data/lit-home/models/...` because the runtime is launched with `LIT_DIR=app_data/lit-home`
- the backend stores the SQLite database beside those directories
- Friday cleans up temp uploads and recordings under `temp/` on startup
- local observability logs live under `logs/`

## Architecture

High-level flow:

1. The React app boots and calls `bootstrap_app`
2. Rust loads settings, ensures there is an active session, and reports both model-backend and web-search status
3. The UI may opportunistically call `warm_backend` when `auto_start_backend` is enabled and the backend is ready but not yet connected
4. On first run, the setup wizard calls `get_setup_status` and then `pull_model`
5. Rust ensures the bundled `lit` binary, embedded CPython runtime, patched LiteRT wheel, and worker script are installed under `app_data/litert-runtime/`
6. The active model is stored under `app_data/lit-home/models/<model-id>/model.litertlm`
7. If web assist is enabled for a chat turn, Rust ensures the localhost SearXNG install is provisioned and healthy before inference starts
8. Chat requests are sent from Rust to the local Python worker, which drives LiteRT-LM and optional tool execution
9. The worker streams answer tokens, thought tokens, tool-call events, and tool results back to Rust, which forwards them to the frontend
10. Rust persists multimodal user content and assistant thinking traces in `messages.content_parts` and promotes the chat title from `New chat` using the first user message when possible

Frontend surfaces:

- Sidebar for session management
- Chat pane with attachment ingestion, microphone capture, web toggle, and thinking toggle
- Assistant bubbles with GitHub-flavored Markdown, KaTeX math, copyable code blocks, and collapsible reasoning
- Footer/header status surfaces that expose session title, backend state, reply language, and generation status
- Settings drawer for model downloads/switching, token budget, reply language, and startup pre-warm behavior

Backend responsibilities:

- Session/message persistence in SQLite
- Local observability setup and log writing to `logs/friday.log`
- Setup/runtime bootstrapping
- Model registry and active-model selection
- Bundled embedded Python runtime installation and sync
- Local SearXNG provisioning, process lifecycle, config sync, and readiness probes for web assist
- Prompt building and history trimming
- Auto-titling sessions from the first user message when the title is still `New chat`
- Persisting multimodal user attachment context and assistant thinking traces in `messages.content_parts`
- Attachment normalization for text, image, and audio inputs
- Optional RAG lookup
- Optional tool-enabled chat rounds
- Runtime warmup, cancellation, and idle shutdown

## Settings And Runtime Behavior

Settings live in SQLite under the `app_settings` JSON key.

Current app settings schema includes:

- `auto_start_backend`
- `user_display_name`
- `chat.reply_language`
- `chat.max_tokens`
- `chat.web_assist_enabled`
- `chat.generation.temperature`
- `chat.generation.top_p`
- `chat.generation.thinking_enabled`

Current behavior worth remembering:

- default max tokens is `4096`
- systems with more than `8 GB` RAM get a higher default token budget of `16384`
- the settings UI uses token presets from `1K` through `128K`
- `temperature` must be between `0.0` and `2.0`
- `top_p` must be between `0.0` and `1.0`
- the settings UI currently exposes reply language, token presets, model downloads/switching, and `auto_start_backend`
- `temperature` and `top_p` are supported by the backend schema but are not currently surfaced in the main settings UI
- the chat composer, not the settings drawer, owns the per-turn web assist and thinking toggles

The sidecar daemon has an idle shutdown policy:

- idle timeout: `10` minutes
- idle check interval: `30` seconds

## Current Database Shape

Migrations live in [`src-tauri/migrations/001_initial.sql`](src-tauri/migrations/001_initial.sql), [`src-tauri/migrations/002_rag.sql`](src-tauri/migrations/002_rag.sql), and [`src-tauri/migrations/003_message_content_parts.sql`](src-tauri/migrations/003_message_content_parts.sql).

Primary tables:

- `sessions`
- `messages`
- `audit_log`
- `workspace_memory`
- `settings`
- `rag_documents`
- `rag_chunks`

Notes:

- SQLite runs with WAL mode
- current session id is persisted under the `current_session` setting key
- app settings are stored as JSON under `app_settings`
- active model id is persisted separately and reloaded during startup
- the `messages` table includes a `content_parts` JSON column for multimodal user content and assistant thinking traces
- session rows start with title `New chat` and are updated from the first user message preview when possible

## Current IPC Surface

Core app commands in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs):

- `bootstrap_app`
- `get_web_search_status`
- `send_message`
- `cancel_generation`
- `read_file_context`
- `save_temp_file`
- `delete_temp_file`
- `create_session`
- `delete_session`
- `list_sessions`
- `select_session`
- `load_messages`
- `load_settings`
- `save_settings`

RAG commands:

- `rag_ingest_file`
- `rag_ingest_folder`
- `rag_search`
- `rag_list_documents`
- `rag_delete_document`
- `rag_stats`
- `set_rag_enabled`
- `set_tools_enabled`

Model/runtime commands:

- `detect_backend`
- `get_backend_status`
- `warm_backend`
- `pull_model`
- `get_system_info`
- `get_setup_status`
- `list_models`
- `list_downloaded_model_ids`
- `get_active_model`
- `select_model`

Events sent to the frontend:

- `chat-token`
- `chat-done`
- `chat-error`
- `model-download-progress`
- `activity`
- `web-search-status`
- `tool-call-start`
- `tool-call-result`

## Development Commands

From repo root:

```bash
npm install
npm run typecheck
npm run tauri dev
npm run build
npm run test:run
npm run cargo:check
npm run cargo:test
npm run cargo:clippy
npm run check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Notes:

- Use `npm run tauri dev` and `npm run tauri build` to stay aligned with the configured frontend hooks in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json)
- there is no root `Cargo.toml`; use `--manifest-path src-tauri/Cargo.toml`
- `npm run check` is the default local validation flow; `npm run cargo:clippy` remains a separate command locally but is required in CI and release workflows
- `npm run tauri build` is currently aligned with the managed runtime only on macOS Apple Silicon because `src-tauri/build.rs` rejects unsupported targets
- web assist depends on Friday's managed embedded CPython runtime plus a pinned first-use SearXNG download

## Implementation Notes For Contributors

- Changing a Tauri command requires updating `generate_handler!` in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)
- If a command payload changes, update the matching TypeScript types in [`src/types.ts`](src/types.ts)
- Model/runtime asset changes usually touch [`src-tauri/build.rs`](src-tauri/build.rs), [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs), [`src-tauri/src/python_runtime.rs`](src-tauri/src/python_runtime.rs), and bundled resources under `src-tauri/resources/`
- LiteRT runtime integration changes typically span [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs), [`src-tauri/src/models/python_worker.rs`](src-tauri/src/models/python_worker.rs), the worker script under [`src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py`](src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py), and sometimes [`src-tauri/python_tests/`](src-tauri/python_tests/)
- Web-assist lifecycle changes usually touch [`src-tauri/src/searxng.rs`](src-tauri/src/searxng.rs), [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs), [`src-tauri/src/models/python_worker.rs`](src-tauri/src/models/python_worker.rs), and [`src/types.ts`](src/types.ts)
- Attachment-flow changes can require coordinated updates across [`src/components/ChatPane.tsx`](src/components/ChatPane.tsx), `read_file_context`, `save_temp_file`, and `delete_temp_file`
- Assistant rendering changes usually touch [`src/components/MessageBubble.tsx`](src/components/MessageBubble.tsx) and [`src/styles.css`](src/styles.css)
- If model capability metadata changes, update both Rust model structs and the mirrored TypeScript types/UI consumers
- RAG behavior lives in [`src-tauri/src/rag/mod.rs`](src-tauri/src/rag/mod.rs)
- CI and release behavior live in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) and [`.github/workflows/release.yml`](.github/workflows/release.yml)

## Current Caveats

- Managed runtime/build support is currently limited to `macos/aarch64`
- RAG exists as backend/API functionality, but there is no dedicated frontend document-management flow yet
- The app is local-first, not network-free; enabling web assist requires a first-use SearXNG download and allows outbound requests through SearXNG search plus direct page fetches
- `temperature` and `top_p` are supported in the backend settings schema but not surfaced in the main settings UI
- Tool execution status is visible in the UI, but detailed tool traces/results are not yet presented as a first-class conversation artifact
- Local file tools remain disabled in the shipped chat flow

## Preferred Mental Model

Friday today is best understood as:

- a working local chat desktop app
- with setup/bootstrap, model management, multimodal attachments, automatic chat titles, and multilingual reply controls in place
- with optional thinking mode and optional web-assisted replies in the main chat flow
- with rich Markdown and reasoning rendering in the conversation UI
- with a Friday-managed localhost SearXNG process behind `web_search`
- with startup pre-warming and daemon lifecycle management already implemented
- and with RAG infrastructure present but not yet fully productized in the UI
