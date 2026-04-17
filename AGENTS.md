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
- Optional per-turn toggles for web assist, Knowledge grounding, and thinking mode
- Assistant rendering with GitHub-flavored Markdown, copyable code blocks, KaTeX math, collapsible reasoning, and collapsible Knowledge sources
- Optional web-assisted replies via a Friday-managed localhost SearXNG stack
- Dedicated Knowledge view for ingesting local files/URLs and managing indexed sources
- Theme selection (light/dark), token budget controls, and model downloads/switching in Settings
- In-app update surfaces for available/installable app updates and restart prompts

Current backend-only or partially surfaced capabilities:

- `knowledge-ingest-progress` events exist, but there is no dedicated per-item ingest timeline UI yet
- `get_system_info` command exists but is not a primary user-facing panel
- The shipped LiteRT-LM Python worker exposes `get_current_datetime`, `web_search`, `web_fetch`, `file_read`, `list_directory`, and `calculate`
- In the shipped chat flow, `get_current_datetime` is always enabled and web assist additionally enables `web_search`, `web_fetch`, and `calculate`; local file helper tools remain disabled for user chats
- Local observability logs are written to `app_data/logs/friday.log`, but there is no dedicated log viewer UI

Privacy note:

- Inference, sessions, settings, Knowledge storage, and local files stay on-device by default
- First-run setup downloads managed LiteRT runtime assets and model files from the network when the bundle is incomplete
- If the user enables web-assisted replies, Friday provisions local SearXNG dependencies on first use and can send search/fetch requests to external sites
- If the user adds URL-based Knowledge sources, Friday fetches those URLs for indexing
- Knowledge embedding models are downloaded on first Knowledge use

## Current Platform Support

Friday's managed runtime flow currently supports macOS Apple Silicon only.

- `src-tauri/build.rs` validates platform assets from the runtime manifest and fails unsupported targets
- the runtime manifest currently declares only `macos/aarch64`
- the shipped worker script path is wired for `macos/aarch64`
- treat Apple Silicon as the supported build and packaging target until additional target specs are added

## Stack

Frontend:

- React 19
- TypeScript
- Vite 6
- Ant Design 5
- `@ai-sdk/react` + `ai`
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
- `anyhow`
- `arrow-array` / `arrow-schema`
- `embed_anything`
- `lancedb` / `lance-index`
- `futures`
- `url`
- `walkdir`

Inference/runtime:

- LiteRT-LM `0.10.1`
- managed native LiteRT runtime via bundled `lit` release assets
- embedded CPython `3.12.10`
- locally patched `litert_lm_api` wheel for Gemma 4 multimodal support

## Model Registry

Model metadata is sourced from the runtime manifest at [`src-tauri/resources/litert-runtime/runtime-manifest.json`](src-tauri/resources/litert-runtime/runtime-manifest.json) and consumed via [`src-tauri/src/runtime_manifest.rs`](src-tauri/src/runtime_manifest.rs).

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
│   ├── lib/
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

- [`src/App.tsx`](src/App.tsx): top-level layout, setup gating, sidebar/drawer behavior, chat/knowledge/settings view switching, and update banners
- [`src/hooks/useAppController.ts`](src/hooks/useAppController.ts): frontend state hub, bootstrapping, event listeners, model inventory, send/cancel flow, settings persistence, knowledge operations, and update actions
- [`src/components/ChatPane.tsx`](src/components/ChatPane.tsx): chat UI, attachments, web/knowledge/thinking toggles, microphone recording, and generation status copy
- [`src/components/KnowledgePanel.tsx`](src/components/KnowledgePanel.tsx): Knowledge source ingest (file/url), source list, and source deletion
- [`src/components/MessageBubble.tsx`](src/components/MessageBubble.tsx): assistant Markdown rendering, reasoning disclosure UI, Knowledge source rendering, code-copy actions, KaTeX math, and safe external-link handling
- [`src/components/SettingsPanel.tsx`](src/components/SettingsPanel.tsx): reply language, token presets, theme mode, and model downloads/switching
- [`src/components/SetupWizard.tsx`](src/components/SetupWizard.tsx): onboarding flow, display-name capture, runtime/model readiness checks, and model download flow
- [`src/lib/tauri-chat-transport.ts`](src/lib/tauri-chat-transport.ts): AI SDK transport bridge to Tauri command/event chat streaming
- [`src/lib/friday-chat.ts`](src/lib/friday-chat.ts): normalization helpers for persisted content parts, reasoning, and Knowledge citations
- [`src-tauri/build.rs`](src-tauri/build.rs): build-time runtime asset verification/vendoring using runtime manifest entries
- [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs): Tauri command handlers, app state, prompt assembly, Knowledge augmentation, persistence flow, streaming event emission, updater commands, and log initialization
- [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs): runtime bootstrap, model downloads, native runtime lifecycle, model selection, and warmup
- [`src-tauri/src/runtime_manifest.rs`](src-tauri/src/runtime_manifest.rs): runtime/model manifest parsing, validation, and platform/model selection policies
- [`src-tauri/src/python_runtime.rs`](src-tauri/src/python_runtime.rs): embedded CPython install/sync helpers
- [`src-tauri/src/searxng.rs`](src-tauri/src/searxng.rs): local SearXNG provisioning, process management, health checks, and web-search status
- [`src-tauri/src/knowledge/mod.rs`](src-tauri/src/knowledge/mod.rs): Knowledge ingestion/search/status, LanceDB integration, and citation shaping
- [`src-tauri/src/models/python_worker.rs`](src-tauri/src/models/python_worker.rs): Rust bridge to the bundled LiteRT-LM Python worker
- [`src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py`](src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py): worker tool hooks and streaming logic
- [`src-tauri/resources/searxng/`](src-tauri/resources/searxng/): vendored Friday-owned SearXNG config, source manifest, and dependency lockfile templates
- [`src-tauri/src/settings.rs`](src-tauri/src/settings.rs): settings schema/defaults/validation
- [`src-tauri/src/storage/mod.rs`](src-tauri/src/storage/mod.rs): SQLite init, migration ledger, and settings helpers

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
  - `app_data/rag/lancedb/`
  - `app_data/rag/models/`
  - `app_data/rag/hf-cache/`
  - `app_data/rag/staging/`

Notes:

- the backend still creates `app_data/models/` during setup, but the managed LiteRT runtime currently stores downloaded model files under `app_data/lit-home/models/...` because the runtime is launched with `LIT_DIR=app_data/lit-home`
- the backend stores SQLite beside these directories
- Friday cleans up temp uploads and recordings under `temp/` on startup
- local observability logs live under `logs/`
- Knowledge storage currently uses the `rag/` app-data directory name even though product/UI terminology is now `Knowledge`

## Architecture

High-level flow:

1. The React app boots and calls `bootstrap_app`
2. Rust loads settings, ensures there is an active session, and reports backend, web-search, and knowledge status
3. The UI opportunistically calls `warm_backend` during startup when backend state is `ready` but not yet connected
4. On first run, setup calls `get_setup_status` and `pull_model`
5. Rust ensures the bundled `lit` binary, embedded CPython runtime, patched LiteRT wheel, and worker script are installed under `app_data/litert-runtime/`
6. The active model is stored under `app_data/lit-home/models/<model-id>/model.litertlm`
7. If web assist is enabled for a turn, Rust ensures the localhost SearXNG stack is provisioned and healthy before inference starts
8. If Knowledge is enabled for a turn, Rust runs Knowledge search and augments the user prompt with retrieved text/image/audio context
9. Chat requests are sent from Rust to the local Python worker, which drives LiteRT-LM and optional tool execution
10. The worker streams answer tokens, thought tokens, tool-call events, and tool results back to Rust, which forwards them to the frontend
11. Rust persists multimodal user content and assistant content parts (thinking/sources), and promotes chat titles from `New chat` using the first user message when possible

Frontend surfaces:

- Sidebar for session management and navigation to chat/knowledge/settings
- Chat pane with attachment ingestion, microphone capture, web/knowledge/thinking toggles, and status hints
- Assistant bubbles with GitHub-flavored Markdown, KaTeX math, copyable code blocks, collapsible reasoning, and collapsible Knowledge sources
- Settings page for model downloads/switching, token budget, reply language, and theme mode
- Knowledge page for source ingestion/listing/deletion and Knowledge status/stats
- Update banners for available updates, installed updates requiring restart, and update errors

Backend responsibilities:

- Session/message persistence in SQLite
- Local observability setup and log writing to `logs/friday.log`
- Setup/runtime bootstrapping
- Runtime manifest parsing and model/platform policy enforcement
- Model registry and active-model selection
- Bundled embedded Python runtime installation and sync
- Local SearXNG provisioning, process lifecycle, config sync, and readiness probes
- Knowledge ingestion/search/status over LanceDB + embedding runtime
- Prompt building and history trimming
- Auto-titling sessions from first user messages when title is still `New chat`
- Persisting multimodal user context and assistant thinking/citations in `messages.content_parts`
- Attachment normalization for text/image/audio inputs
- Runtime warmup, cancellation, and idle shutdown
- App update check/install/restart command handling

## Settings And Runtime Behavior

Settings live in SQLite under the `app_settings` JSON key.

Current app settings schema includes:

- `auto_start_backend` (legacy persisted field; normalized to true)
- `user_display_name`
- `theme_mode`
- `chat.reply_language`
- `chat.max_tokens`
- `chat.web_assist_enabled`
- `chat.knowledge_enabled`
- `chat.generation.temperature`
- `chat.generation.top_p`
- `chat.generation.thinking_enabled`

Current behavior worth remembering:

- default max tokens is `4096`
- systems with more than `8 GB` RAM get a higher default token budget of `16384`
- settings UI uses token presets from `1K` through `128K`
- `temperature` must be between `0.0` and `2.0`
- `top_p` must be between `0.0` and `1.0`
- settings UI currently exposes reply language, token presets, theme mode, and model downloads/switching
- `temperature` and `top_p` are supported in backend schema but not surfaced in the main settings page
- chat composer owns per-turn web/knowledge/thinking toggles

The sidecar daemon idle shutdown policy (from runtime manifest policy):

- idle timeout: `10` minutes
- idle check interval: `30` seconds

Knowledge runtime idle policy:

- idle timeout: `2` minutes
- idle check interval: `30` seconds

## Current Database Shape

Migrations currently used by storage init:

- [`src-tauri/migrations/001_initial.sql`](src-tauri/migrations/001_initial.sql)
- [`src-tauri/migrations/003_message_content_parts.sql`](src-tauri/migrations/003_message_content_parts.sql)
- [`src-tauri/migrations/004_knowledge.sql`](src-tauri/migrations/004_knowledge.sql)
- [`src-tauri/migrations/005_migration_ledger.sql`](src-tauri/migrations/005_migration_ledger.sql)

Primary tables:

- `sessions`
- `messages`
- `audit_log`
- `workspace_memory`
- `settings`
- `knowledge_sources`
- `legacy_rag_archive_log`
- `migration_ledger`

Notes:

- SQLite runs with WAL mode
- current session id is persisted under `current_session`
- app settings are stored as JSON under `app_settings`
- active model id is persisted under `active_model_id`
- `messages` includes `content_parts` for multimodal user context and assistant thinking/sources
- legacy `rag_documents` / `rag_chunks` are archived during migration flow and are not part of the active schema

## Current IPC Surface

Commands registered in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs):

Core app/chat commands:

- `bootstrap_app`
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
- `open_external_link`

Knowledge commands:

- `knowledge_ingest_file`
- `knowledge_ingest_url`
- `knowledge_list_sources`
- `knowledge_delete_source`
- `knowledge_stats`
- `get_knowledge_status`
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

Web search command:

- `get_web_search_status`

Updater commands:

- `check_for_app_update`
- `install_app_update`
- `restart_app`

Events emitted from backend:

- `chat-token`
- `chat-done`
- `chat-error`
- `model-download-progress`
- `web-search-status`
- `tool-call-start`
- `tool-call-result`
- `knowledge-status`
- `knowledge-ingest-progress`

## Development Commands

From repo root:

```bash
npm install
npm run typecheck
npm run test:run
npm run python:test
npm run tauri dev
npm run tauri build
npm run build
npm run cargo:check
npm run cargo:test
npm run cargo:clippy
npm run check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Notes:

- use `npm run tauri dev` and `npm run tauri build` to stay aligned with frontend hooks in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json)
- there is no root `Cargo.toml`; use `--manifest-path src-tauri/Cargo.toml`
- `npm run check` is the default local validation flow
- `npm run cargo:clippy` is available as a separate local quality gate
- `npm run tauri build` is currently aligned with managed runtime support only on macOS Apple Silicon

## Implementation Notes For Contributors

- Changing a Tauri command requires updating `generate_handler!` in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)
- If command payloads change, update matching TypeScript types in [`src/types.ts`](src/types.ts) and transport mapping in [`src/lib/tauri-chat-transport.ts`](src/lib/tauri-chat-transport.ts)
- Runtime/model asset changes usually touch [`src-tauri/build.rs`](src-tauri/build.rs), [`src-tauri/src/runtime_manifest.rs`](src-tauri/src/runtime_manifest.rs), [`src-tauri/resources/litert-runtime/runtime-manifest.json`](src-tauri/resources/litert-runtime/runtime-manifest.json), and [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs)
- LiteRT worker integration changes typically span [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs), [`src-tauri/src/models/python_worker.rs`](src-tauri/src/models/python_worker.rs), and [`src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py`](src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py)
- Web-assist lifecycle changes usually touch [`src-tauri/src/searxng.rs`](src-tauri/src/searxng.rs), [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs), [`src-tauri/src/models/python_worker.rs`](src-tauri/src/models/python_worker.rs), and [`src/types.ts`](src/types.ts)
- Knowledge behavior lives in [`src-tauri/src/knowledge/mod.rs`](src-tauri/src/knowledge/mod.rs) with UI in [`src/components/KnowledgePanel.tsx`](src/components/KnowledgePanel.tsx)
- Attachment-flow changes can require coordinated updates across [`src/components/ChatPane.tsx`](src/components/ChatPane.tsx), `read_file_context`, `save_temp_file`, and `delete_temp_file`
- Assistant rendering and citation/reasoning presentation usually touch [`src/components/MessageBubble.tsx`](src/components/MessageBubble.tsx), [`src/lib/friday-chat.ts`](src/lib/friday-chat.ts), and [`src/styles.css`](src/styles.css)
- Release automation currently lives in [`.github/workflows/release.yml`](.github/workflows/release.yml)

## Current Caveats

- Managed runtime/build support is currently limited to `macos/aarch64`
- Knowledge model provisioning happens lazily on first use and can add noticeable first-run latency
- The app is local-first, not network-free: web assist requires first-use SearXNG provisioning and performs outbound search/fetch requests; URL-based Knowledge ingest also fetches network content
- `temperature` and `top_p` are supported in backend settings but not exposed in the current settings UI
- Tool execution status is visible in the UI, but full raw tool traces are not shown as first-class conversation artifacts
- Local file helper tools (`file_read`, `list_directory`) remain disabled in normal chat flows
- Auto-update command surface exists, but update checks require a correctly configured updater signing key

## Preferred Mental Model

Friday today is best understood as:

- a working local chat desktop app
- with setup/bootstrap, model management, multimodal attachments, automatic chat titles, and multilingual reply controls in place
- with optional per-turn web assist, Knowledge grounding, and thinking mode in the main chat flow
- with rich Markdown/reasoning rendering and explicit source disclosure for Knowledge-grounded replies
- with a Friday-managed localhost SearXNG process behind web assist
- with managed runtime lifecycle (warmup, cancellation, idle shutdown) implemented
- with a dedicated Knowledge workspace for file/URL ingestion and local retrieval-backed prompt augmentation
