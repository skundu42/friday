# Friday

Friday is a local-first desktop AI assistant. It runs Gemma 4 models on-device through a Friday-managed LiteRT runtime, stores chats and settings in local SQLite, supports multimodal attachments, and can optionally provision a localhost SearXNG stack for web-assisted replies.

## Why Friday

- Local-first by default: chats, prompts, settings, and attached files stay on-device unless the user explicitly enables web assist.
- Real desktop app: React + Tauri UI with a Rust backend, not a browser-only shell.
- Managed runtime flow: Friday installs and maintains the bundled LiteRT runtime, embedded CPython runtime, worker script, and patched LiteRT Python wheel itself.
- Practical multimodality: text/code files, PDFs, DOCX, images, and audio can all be attached in the main chat flow.
- Contributor-friendly structure: UI code lives in `src/`; app/runtime logic lives in `src-tauri/`.

## Platform Support

Current managed-runtime builds are supported on macOS Apple Silicon.

- `src-tauri/build.rs` currently vendors the managed LiteRT runtime only for `macos/aarch64`.
- The bundled CPython runtime, patched `litert_lm_api` wheel, and worker script are also wired for `macos/aarch64` today.
- Treat Apple Silicon as the supported build and packaging target until additional runtime specs are added.

## Current Status

`v0.1.0` currently ships:

- Streaming local chat with persistent sessions
- Automatic chat titles derived from the first user message while new chats still start as `New chat`
- First-run setup wizard with display-name capture, runtime readiness checks, and model download progress
- Responsive layout with a docked sidebar on wide screens and a drawer-based sidebar on narrow screens
- Two built-in local models: `Gemma 4 E2B` and `Gemma 4 E4B`
- File attachments for text/code files, PDFs, DOCX, images, and audio
- In-app microphone recording for audio prompts when the environment supports it
- Reply language control for English, Hindi, Bengali, Marathi, Tamil, and Punjabi
- Optional thinking mode for supported models
- Assistant reasoning disclosure with a collapsible reasoning panel
- Rich assistant message rendering with GitHub-flavored Markdown, copyable code blocks, and KaTeX math
- Optional web-assisted replies from the chat composer
- Friday-managed localhost SearXNG provisioning and startup for web search when web assist is enabled
- Model download, switching, RAM checks, token-budget controls, and startup pre-warming controls
- Backend RAG ingestion/search commands and prompt-time RAG augmentation hooks
- Local log output under the app-data `logs/` directory

Not fully productized yet:

- No dedicated frontend RAG document manager
- Tool activity is surfaced in the UI as inline status, not as a full transcript artifact
- The backend has local file helper tools, but normal chat keeps them disabled
- `temperature` and `top_p` are persisted in backend settings, but they are not exposed in the main settings UI

## Privacy And Network Behavior

Friday is on-device by default:

- chats are stored in local SQLite
- models and runtime assets are stored in the platform app-data directory
- attached files are read and normalized locally before they are added to prompts
- audio recording stays local and is passed to the local model runtime

Friday still uses the network in a few cases:

- first-run runtime and model setup
- explicit model downloads
- optional web-assisted replies when the user enables the web toggle and Friday downloads the pinned local SearXNG source/dependency set on first use

If web assist is off, normal chatting does not require network access after setup.

Web assist operational notes:

- Friday manages a localhost-only SearXNG Python process under the app-data directory on demand.
- Friday reuses its bundled embedded CPython runtime and downloads the pinned SearXNG source archive plus wheel-locked dependencies on first use.
- Friday validates both `/healthz` and `/search?format=json` before allowing a tool-enabled chat turn.
- The shipped chat flow always allows a local date/time tool, and web assist additionally enables `web_search`, `web_fetch`, and `calculate`.

## Model Registry

The app ships a small built-in model registry in [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs).

| Model | Download | Minimum RAM | Context | Recommended Output | Capabilities |
| --- | ---: | ---: | ---: | ---: | --- |
| `Gemma 4 E2B` | ~2.41 GB | 4 GB | 131,072 | 4,096 | text, image, audio, thinking |
| `Gemma 4 E4B` | ~3.40 GB | 8 GB | 131,072 | 8,192 | text, image, audio, thinking |

Friday defaults to `Gemma 4 E2B` on most systems and to `Gemma 4 E4B` when total RAM is above `16 GB`.

## Architecture

```text
React app
  -> Tauri IPC commands
Rust backend
  -> settings/session persistence
  -> managed LiteRT runtime installer
  -> embedded CPython + worker bootstrap
  -> localhost SearXNG manager (web assist only)
Python worker
  -> LiteRT-LM Python API
  -> optional tool execution
LiteRT-LM runtime
  -> Gemma 4 local inference
```

Responsibilities:

- `src/`: UI, session navigation, chat interactions, attachments, reasoning display, settings
- `src/components/MessageBubble.tsx`: Markdown rendering, code-copy UI, reasoning disclosure, KaTeX math
- `src/hooks/useAppController.ts`: app state hub, event listeners, session/message flow, settings persistence
- `src-tauri/src/lib.rs`: IPC surface, prompt assembly, persistence flow, local observability setup, streaming events
- `src-tauri/src/sidecar.rs`: model registry, runtime bootstrap, model download lifecycle, worker warmup, idle shutdown
- `src-tauri/src/python_runtime.rs`: embedded CPython installation/sync helpers
- `src-tauri/src/searxng.rs`: local SearXNG provisioning, process lifecycle, health checks, and status reporting
- `src-tauri/src/models/python_worker.rs`: Rust bridge to the bundled Friday Python worker
- `src-tauri/resources/litert-python/macos-aarch64/worker/friday_litert_worker.py`: LiteRT-LM worker implementation, tool hooks, streaming protocol, and SearXNG-backed web search
- `src-tauri/src/rag/mod.rs`: local RAG ingestion and search
- `src-tauri/build.rs`: build-time runtime vendoring and bundled asset path wiring

Persistence details:

- SQLite stores sessions, messages, settings, and RAG metadata locally.
- `messages.content_parts` persists multimodal user content and assistant thinking traces alongside the plain-text message body.
- Session titles start as `New chat` and are promoted to a preview of the first user message when possible.

## Tech Stack

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
- `tokio`
- `reqwest`
- `serde` / `serde_json`
- `tracing` / `tracing-subscriber`
- `sysinfo`
- `base64`
- `flate2`
- `tar`
- `zip`
- `sha2`

Inference/runtime:

- LiteRT-LM `0.10.1`
- bundled `lit` runtime managed by Friday
- embedded CPython `3.12.10`
- locally patched `litert_lm_api` wheel for Gemma 4 image slots

## Getting Started

### Prerequisites

For local development you need:

- Node.js `24.1.0` from [`.nvmrc`](.nvmrc) or a compatible version
- npm
- Rust toolchain
- Tauri 2 system prerequisites for your OS
- macOS Apple Silicon if you want the managed runtime flow to work end-to-end without extra porting work

Friday does not require a separately installed system Python runtime for the shipped app flow.

### Install Dependencies

```bash
npm install
```

### Run In Development

```bash
npm run tauri dev
```

### Build

Build the frontend bundle:

```bash
npm run build
```

Build the desktop app:

```bash
npm run tauri build
```

Current note: `npm run tauri build` is aligned with the managed runtime only on macOS Apple Silicon because `src-tauri/build.rs` rejects other target OS/arch combinations today.

### Test And Check

```bash
npm run test:run
npm run typecheck
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run cargo:clippy
npm run check
```

`npm run check` is the default local validation flow. CI and release workflows additionally run `npm run cargo:clippy`.

### Manual Verification

- Web assist off: normal local chat should work without preparing or starting SearXNG.
- First web-assisted send on a clean machine: Friday should create `app_data/searxng/`, download the pinned source/dependency artifacts, install them, start the local process, pass readiness probes, and return search-backed tool results.
- Offline first use with web assist on: the send should fail with an actionable provisioning error and the same prompt should still work with web assist disabled.
- Broken local SearXNG config with `json` removed from `search.formats`: readiness should fail with `Local SearXNG config is invalid; JSON output is disabled.`
- App shutdown and relaunch: Friday should stop its managed SearXNG process on clean exit and clean up stale orphaned SearXNG and worker processes on next startup.

## First-Run Setup

On first launch, Friday will:

1. Inspect system RAM and select a default model.
2. Check whether the bundled LiteRT runtime assets are installed.
3. Prepare local runtime, log, RAG, temp, and SearXNG directories.
4. Install the bundled `lit` binary, embedded CPython runtime, patched LiteRT Python wheel, and worker script if needed.
5. Download the active model with resumable progress events.
6. Optionally pre-warm the backend when startup pre-warming is enabled.

The setup wizard listens to `model-download-progress` events to drive the UI.

## Features In The Current UI

- Setup wizard with user display-name capture
- Session sidebar with create/select/delete flows
- Automatic chat title updates after the first user message
- Drawer-based session navigation on narrow layouts
- Streaming chat pane with assistant answer and thought streaming
- Drag-and-drop and file-picker attachment flow
- Audio recording button when microphone capture is available
- Reply language selector
- Web search toggle
- Thinking toggle
- Markdown answers with code-copy controls and KaTeX math
- Collapsible reasoning panel when a reply includes thinking content
- Connection/privacy status pills and inline tool-activity status text
- Settings drawer for token budget, model switching/downloads, and startup pre-warm behavior

## Project Layout

```text
daksha-ai/
├── README.md
├── AGENTS.md
├── package.json
├── vite.config.ts
├── .github/
│   └── workflows/
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── styles.css
│   ├── components/
│   ├── hooks/
│   ├── test/
│   ├── theme/
│   └── types.ts
└── src-tauri/
    ├── build.rs
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── migrations/
    ├── python_tests/
    ├── resources/
    └── src/
```

Important files:

- [`src/App.tsx`](src/App.tsx): top-level layout, setup gating, sidebar/drawer behavior
- [`src/components/ChatPane.tsx`](src/components/ChatPane.tsx): chat UI, attachments, web/thinking/audio controls
- [`src/components/MessageBubble.tsx`](src/components/MessageBubble.tsx): Markdown rendering, reasoning disclosure, and copy actions
- [`src/components/SettingsPanel.tsx`](src/components/SettingsPanel.tsx): model management, token budget, reply language, startup pre-warm settings
- [`src/components/SetupWizard.tsx`](src/components/SetupWizard.tsx): first-run onboarding and download flow
- [`src/hooks/useAppController.ts`](src/hooks/useAppController.ts): app state hub, event listeners, message flow, settings persistence
- [`src/test/setup.ts`](src/test/setup.ts): shared Vitest/jsdom setup
- [`src-tauri/build.rs`](src-tauri/build.rs): runtime asset vendoring and build-time path wiring
- [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs): IPC surface and persistence/prompt pipeline
- [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs): model/runtime lifecycle
- [`src-tauri/src/python_runtime.rs`](src-tauri/src/python_runtime.rs): embedded CPython runtime installation helpers
- [`src-tauri/src/searxng.rs`](src-tauri/src/searxng.rs): local SearXNG provisioning, process lifecycle, and readiness checks
- [`src-tauri/src/models/python_worker.rs`](src-tauri/src/models/python_worker.rs): Rust-side worker protocol and prompt normalization
- [`src-tauri/src/rag/mod.rs`](src-tauri/src/rag/mod.rs): RAG ingestion/search

## Runtime Data

Friday stores app data in the platform app-data directory. On macOS, the Tauri identifier is `com.friday.app`, so the app data typically lives under:

```text
~/Library/Application Support/com.friday.app/
```

Important paths:

- `friday.db`
- `logs/friday.log`
- `litert-runtime/0.10.1/`
- `lit-home/`
- `lit-home/models/<model-id>/model.litertlm`
- `searxng/`
- `temp/`
- `rag/`
- `models/`

Notes:

- Friday still creates `models/` during setup, but the managed LiteRT runtime currently stores model files under `lit-home/models/...` because the runtime is launched with `LIT_DIR=app_data/lit-home`.
- Temporary uploaded and recorded files live under `temp/` and are cleaned up on startup.

## Release Workflow

The repo includes a PR/main CI workflow in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) and a tag-driven macOS release workflow in [`.github/workflows/release.yml`](.github/workflows/release.yml).

Current release behavior:

- any pushed tag triggers the release workflow
- the tag must point to a commit reachable from `main`
- the tag must match `package.json` and `src-tauri/tauri.conf.json`, with or without a leading `v`
- frontend typecheck, tests, build, `cargo check`, `cargo test`, and `cargo clippy` run before publishing
- GitHub release notes are generated automatically
- prereleases can fall back to ad-hoc signing when Apple signing secrets are missing
- stable releases require the full macOS signing and notarization secret set
- Apple Silicon is the supported packaging target today because `src-tauri/build.rs` only vendors the managed runtime for `macos/aarch64`

Accepted tag formats:

- `v0.1.0`
- `0.1.0`

## Contributing

- Issues and pull requests are the intended contribution path.
- Use `npm run tauri dev` and `npm run tauri build` so the frontend hooks defined in `src-tauri/tauri.conf.json` stay in sync.
- There is no root `Cargo.toml`; use `--manifest-path src-tauri/Cargo.toml`.
- When changing a Tauri command or payload, update both Rust handlers and the matching TypeScript types in [`src/types.ts`](src/types.ts).
- Model/runtime changes usually span `src-tauri/build.rs`, `src-tauri/src/sidecar.rs`, `src-tauri/src/python_runtime.rs`, and the bundled resource tree under `src-tauri/resources/`.

## Current Limitations

- RAG is implemented in the backend but not exposed as a complete end-user document workflow.
- The app is local-first, not network-free; enabling web assist allows outbound requests through Friday-managed tooling.
- Changing the model or some generation settings can restart the local runtime before the next reply.
- Tool-call results are emitted internally, but the conversation UI still shows them only as status text rather than a first-class transcript artifact.
- Local file tools are intentionally disabled in the shipped chat path.
- `temperature` and `top_p` are supported by the backend settings schema but not surfaced in the main settings UI.

## License

This repository does not currently include a standalone `LICENSE` file. Add one before treating the project as broadly redistributable open source.
