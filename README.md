# Friday

Friday is a local-first desktop AI assistant with no manual setup. It runs Gemma 4 models on-device, keeps chat history in local SQLite, supports multimodal attachments, and can optionally use a lightweight web-assist tool path when the user explicitly enables it.

## Why Friday

- Local-first by default: chats, models, prompts, and attached files stay on-device unless the user turns on web assist.
- Real desktop app: Tauri frontend plus a Rust backend, not a browser-only wrapper.
- Bundled runtime flow: Friday manages the native LiteRT runtime and first-run model download itself.
- Practical multimodality: text, code, PDF, DOCX, image, and audio inputs are supported in the chat flow.
- Contributor-friendly architecture: the UI is in `src/`, the app/runtime logic is in `src-tauri/`.

## Current Status

`v0.1.0` currently ships:

- Streaming local chat with persistent sessions
- First-run setup wizard for model download and runtime readiness
- Two built-in local models: `Gemma 4 E2B` and `Gemma 4 E4B`
- File attachments for text/code files, PDFs, DOCX, images, and audio
- In-app microphone recording for audio prompts when the environment supports it
- Reply language control for English, Hindi, Bengali, Marathi, Tamil, and Punjabi
- Optional thinking mode for supported models
- Optional web-assisted replies from the chat composer
- Model download, switching, RAM checks, and startup pre-warming controls
- Backend RAG ingestion/search commands and prompt-time RAG augmentation hooks

Not fully productized yet:

- No dedicated frontend RAG document manager
- Session titles are still created as `New chat`
- Tool activity is surfaced in the UI only as status text, not as a full tool transcript
- The backend contains local file helper tools, but normal chat currently enables only web tools and calculator access when web assist is on

## Privacy And Network Behavior

Friday is on-device by default:

- chats are stored in local SQLite
- models are stored in the platform app-data directory
- attached files are read and normalized locally before they are added to prompts
- audio recording stays local and is passed to the local model runtime

Friday still uses the network in a few cases:

- first-run runtime/model setup
- explicit model downloads
- optional web-assisted replies when the user enables the web toggle

If web assist is off, normal chatting does not require network access after setup.

## Model Registry

The app currently ships a small built-in model registry in [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs).

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
  -> managed local LiteRT runtime over loopback HTTP
LiteRT-LM runtime
  -> Gemma 4 local inference
```

Responsibilities:

- `src/`: UI, settings, chat interactions, attachments, session navigation
- `src-tauri/src/lib.rs`: Tauri commands, persistence flow, prompt assembly, streaming events
- `src-tauri/src/sidecar.rs`: runtime bootstrap, model registry, model download lifecycle, daemon warmup/shutdown
- `src-tauri/src/models/litert.rs`: LiteRT request building, native tool declarations, multimodal request handling
- `src-tauri/src/rag/mod.rs`: local RAG ingestion and search

## Tech Stack

Frontend:

- React 19
- TypeScript
- Vite 6
- Ant Design 5
- `@tauri-apps/api` v2

Backend:

- Tauri 2
- Rust 2021
- `rusqlite` with bundled SQLite
- `tokio`
- `reqwest`
- `serde` / `serde_json`

Inference/runtime:

- LiteRT-LM `0.10.1`
- managed native LiteRT runtime from bundled `lit` assets

## Getting Started

### Prerequisites

For local development you need:

- Node.js and npm
- Rust toolchain
- Tauri 2 system prerequisites for your OS

Friday does not require a preinstalled Python runtime for the shipped app flow.

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

### Test And Check

```bash
npm run test:run
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

## First-Run Setup

On first launch, Friday will:

1. Inspect system RAM and select a default model.
2. Check whether the managed LiteRT runtime is installed.
3. Prepare local runtime, cache, model, and temp directories.
4. Download the active model with resumable progress events.
5. Mark the app ready for chat once runtime and model requirements are satisfied.

The setup wizard listens to `model-download-progress` events to drive the UI.

## Features In The Current UI

- Setup wizard with user display-name capture
- Session sidebar with create/select/delete flows
- Streaming chat pane with assistant answer and thought streaming
- Drag-and-drop and file-picker attachment flow
- Audio recording button when microphone capture is available
- Reply language selector
- Web search toggle
- Thinking toggle
- Settings drawer for token budget, model switching, downloads, and startup pre-warm behavior

## Project Layout

```text
daksha-ai/
├── README.md
├── AGENTS.md
├── package.json
├── src/
│   ├── App.tsx
│   ├── components/
│   ├── hooks/
│   ├── theme/
│   └── types.ts
└── src-tauri/
    ├── Cargo.toml
    ├── migrations/
    ├── tauri.conf.json
    └── src/
```

Important files:

- [`src/App.tsx`](src/App.tsx): top-level layout, drawer behavior, setup gating
- [`src/hooks/useAppController.ts`](src/hooks/useAppController.ts): app state hub, event listeners, message flow, settings persistence
- [`src/components/ChatPane.tsx`](src/components/ChatPane.tsx): chat UI, attachments, web/thinking/audio controls
- [`src/components/SettingsPanel.tsx`](src/components/SettingsPanel.tsx): model management, token budget, startup pre-warm settings
- [`src/components/SetupWizard.tsx`](src/components/SetupWizard.tsx): first-run onboarding and download flow
- [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs): IPC surface and persistence/prompt pipeline
- [`src-tauri/src/sidecar.rs`](src-tauri/src/sidecar.rs): model/runtime lifecycle
- [`src-tauri/src/models/litert.rs`](src-tauri/src/models/litert.rs): inference request construction and tool execution
- [`src-tauri/src/rag/mod.rs`](src-tauri/src/rag/mod.rs): RAG ingestion/search

## Runtime Data

Friday stores app data in the platform app-data directory. On macOS, the Tauri identifier is `com.friday.app`, so the app data typically lives under:

```text
~/Library/Application Support/com.friday.app/
```

Important paths:

- `friday.db`
- `models/`
- `litert-runtime/`
- `litert-cache/`
- `temp/`
- `rag/`

## Release Workflow

The repo includes a tag-driven macOS release workflow in [`.github/workflows/release.yml`](.github/workflows/release.yml).

Current release behavior:

- any pushed tag triggers the workflow
- the tag must point to a commit reachable from `main`
- the tag must match `package.json` and `src-tauri/tauri.conf.json`
- frontend tests and `cargo check` run before publishing
- macOS builds are produced for Apple Silicon and Intel
- GitHub release notes are generated automatically
- if Apple signing secrets are missing, the workflow falls back to ad-hoc signing

Accepted tag formats:

- `v0.1.0`
- `0.1.0`

## Contributing

- Issues and pull requests are the intended contribution path.
- Use `npm run tauri dev` and `npm run tauri build` so the frontend hooks defined in `src-tauri/tauri.conf.json` stay in sync.
- There is no root `Cargo.toml`; use `--manifest-path src-tauri/Cargo.toml`.
- When changing a Tauri command or payload, update both Rust handlers and the matching TypeScript types in [`src/types.ts`](src/types.ts).
- Model/runtime changes usually span both the backend sidecar code and the settings/setup UI.

## Current Limitations

- RAG is implemented in the backend but not exposed as a complete end-user document workflow.
- The chat footer still frames the product as local-first even though enabling web assist allows outbound requests.
- Changing the model or some generation settings can cause the local runtime to restart before the next reply.
- Tool permissions are conservative in the shipped UI path.

## License

This repository does not currently include a standalone `LICENSE` file. Add one before treating the project as broadly redistributable open source.
