# Friday

Friday is a your personal local AI assistant which runs efficienltly even in a 8gb Macbook Air. Private by design so works 100% offline. Keep your data where it belongs - with you!

## Why Friday

- Zero Setup needed. Install and get started right away.
- Local-first by default: chats, prompts, settings, and attached files stay on-device.
- Supports toolcalling including web search out of the box.
- Practical multimodality: text/code files, PDFs, DOCX, images, and audio can all be attached in the main chat flow.
- Runs Google Gemma models which are highly capable efficiently by using Google's own llm runtime engine natively.

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

## License

Check the License.md file for license details
