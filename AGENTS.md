# AGENTS.md — Friday Codebase Reference

## Product Snapshot

Friday is a local-first desktop AI assistant built with Tauri 2, Rust, React 19, and LiteRT-LM. The app runs Gemma 4 models on-device through a managed native LiteRT runtime that Friday installs, warms, and shuts down itself.

Current user-facing app capabilities:

- Streaming local chat with persistent sessions
- First-run setup wizard with display-name capture and model download progress
- File attachments in chat, including text/code files, PDFs, DOCX, images, and audio
- Microphone recording for audio prompts when the environment supports `MediaRecorder`
- Model management for `Gemma 4 E2B` and `Gemma 4 E4B`
- Reply language control for English, Hindi, Bengali, Marathi, Tamil, and Punjabi
- Optional thinking mode for supported models
- Optional web-assisted replies via the chat composer
- Settings for token budget, model downloads/switching, and startup pre-warming

Current backend-only or partially surfaced capabilities:

- RAG ingestion and search commands exist in the backend
- Prompt-time RAG augmentation exists, but RAG is disabled by default and not wired to a dedicated UI
- The LiteRT integration contains tool declarations for `web_search`, `web_fetch`, `file_read`, `list_directory`, and `calculate`
- In the shipped chat flow, web assist currently enables `web_search`, `web_fetch`, and `calculate`; local file helper tools are not enabled for user chats

Privacy note:

- Inference, sessions, settings, and local files stay on-device by default
- First-run setup downloads the native LiteRT runtime assets and model files from the network
- If the user enables web-assisted replies, Friday can send search/fetch requests to external sites

## Stack

Frontend:

- React 19
- TypeScript
- Vite 6
- Ant Design 5
- `@tauri-apps/api` v2
- `@tauri-apps/plugin-dialog` v2
- `react-markdown` + `remark-gfm`
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
- `tracing`
- `pdf-extract`
- `zip`
- `meval`

Inference/runtime:

- LiteRT-LM `0.10.1`
- Managed native LiteRT runtime via bundled `lit` release assets

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
├── package.json
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── styles.css
│   ├── types.ts
│   ├── components/
│   ├── hooks/
│   └── theme/
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── migrations/
    └── src/
```

Key files:

- [`src/App.tsx`](src/App.tsx): top-level layout, setup gating, sidebar/drawer behavior, settings/chat split
- [`src/hooks/useAppController.ts`](src/hooks/useAppController.ts): frontend state hub, bootstrapping, event listeners, model inventory, send/cancel flow, startup warmup
- [`src/components/ChatPane.tsx`](src/components/ChatPane.tsx): chat UI, attachments, web/thinking toggles, microphone recording
- [`src/components/SettingsPanel.tsx`](src/components/SettingsPanel.tsx): reply language, token presets, model downloads/switching, startup pre-warm toggle
- [`src/components/SetupWizard.tsx`](src/components/SetupWizard.tsx): first-run onboarding and model download flow
- [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs): Tauri commands, app state, prompt assembly, persistence flow, streaming event emission
- [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs): runtime bootstrap, model downloads, native runtime lifecycle, model registry, warmup
- [`src-tauri/src/models/litert.rs`](src-tauri/src/models/litert.rs): LiteRT runtime client bridge, multimodal request building, tool declarations/execution
- [`src-tauri/src/rag/mod.rs`](src-tauri/src/rag/mod.rs): Rust-owned RAG ingestion and search
- [`src-tauri/src/settings.rs`](src-tauri/src/settings.rs): settings schema, defaults, validation
- [`src-tauri/src/storage/mod.rs`](src-tauri/src/storage/mod.rs): SQLite init and setting helpers

## Runtime And Data Paths

Friday uses the platform app-data directory. On macOS the identifier is `com.friday.app`.

Important subdirectories:

- `app_data/friday.db`
- `app_data/models/`
- `app_data/litert-runtime/`
- `app_data/litert-cache/`
- `app_data/temp/`
- `app_data/rag/`

The backend sets the models directory during Tauri setup, stores the SQLite database beside it, and manages temporary uploaded/recorded files under `temp/`.

## Architecture

High-level flow:

1. The React app boots and calls `bootstrap_app`
2. Rust loads settings, ensures there is an active session, and reports backend status
3. The UI may opportunistically call `warm_backend` when `auto_start_backend` is enabled and the backend is ready but not yet connected
4. On first run, the setup wizard calls `get_setup_status` and then `pull_model`
5. Rust ensures the native LiteRT runtime is installed and downloads the active model
6. Chat requests are sent from Rust to the local LiteRT runtime
7. The runtime streams tokens back; Rust forwards them to the frontend with Tauri events
8. Thought tokens, answer tokens, and tool status updates are merged in the frontend controller

Frontend surfaces:

- Sidebar for session management
- Chat pane with attachment ingestion, microphone capture, web toggle, and thinking toggle
- Footer/header status surfaces that expose session title, backend state, reply language, and generation status
- Settings drawer for model downloads, switching, token budget, and startup pre-warm behavior

Backend responsibilities:

- Session/message persistence in SQLite
- Setup/runtime bootstrapping
- Model registry and active-model selection
- Prompt building and history trimming
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
- systems with higher RAM get a higher default token budget in settings bootstrap logic
- `temperature` must be between `0.0` and `2.0`
- `top_p` must be between `0.0` and `1.0`
- the settings UI currently exposes reply language, token presets, and `auto_start_backend`
- `temperature` and `top_p` are supported by the backend schema but are not currently surfaced in the main settings UI

The sidecar daemon has an idle shutdown policy:

- idle timeout: `10` minutes
- idle check interval: `30` seconds

## Current Database Shape

Migrations live in [`src-tauri/migrations/001_initial.sql`](src-tauri/migrations/001_initial.sql) and [`src-tauri/migrations/002_rag.sql`](src-tauri/migrations/002_rag.sql).

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

## Current IPC Surface

Core app commands in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs):

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
- `tool-call-start`
- `tool-call-result`

## Development Commands

From repo root:

```bash
npm install
npm run tauri dev
npm run build
npm run test:run
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Notes:

- Use `npm run tauri dev` and `npm run tauri build` to stay aligned with the configured frontend hooks in [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json)
- There is no root `Cargo.toml`; use `--manifest-path src-tauri/Cargo.toml`

## Implementation Notes For Contributors

- Changing a Tauri command requires updating `generate_handler!` in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)
- If a command payload changes, update the matching TypeScript types in [`src/types.ts`](src/types.ts)
- Model-related changes usually touch both [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs) and the settings/setup UI
- LiteRT runtime integration changes typically span [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs), [`src-tauri/src/models/litert.rs`](src-tauri/src/models/litert.rs), and the status/setup UI
- Attachment-flow changes can require coordinated updates across [`src/components/ChatPane.tsx`](src/components/ChatPane.tsx), `read_file_context`, `save_temp_file`, and `delete_temp_file`
- If model capability metadata changes, update both Rust model structs and the mirrored TypeScript types/UI consumers
- RAG behavior lives in [`src-tauri/src/rag/mod.rs`](src-tauri/src/rag/mod.rs)

## Current Caveats

- Session titles are still static `New chat`
- RAG exists as backend/API functionality, but there is no dedicated frontend document-management flow yet
- The app is local-first, not network-free; enabling web assist allows outbound requests
- `temperature` and `top_p` are supported in the backend settings schema but not surfaced in the main settings UI
- Tool execution status is visible in the UI, but detailed tool traces/results are not yet presented as a first-class conversation artifact

## Preferred Mental Model

Friday today is best understood as:

- a working local chat desktop app
- with setup/bootstrap, model management, multimodal attachments, and multilingual reply controls in place
- with optional thinking mode and optional web-assisted replies in the main chat flow
- with startup pre-warming and daemon lifecycle management already implemented
- and with RAG infrastructure present but not yet fully productized in the UI
