import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { BackendStatus } from "./types";

const invokeMock = vi.fn();
const listenMock = vi.fn();
const controllerState = vi.fn();
const nativeGetComputedStyle = window.getComputedStyle.bind(window);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("./hooks/useAppController", () => ({
  useAppController: () => controllerState(),
}));

const backendStatus: BackendStatus = {
  backend: "LiteRtLm",
  connected: true,
  models: ["gemma-4-e2b-it.litertlm"],
  base_url: "",
  total_ram_gb: 16,
  state: "connected",
  message: "ready",
  supports_native_tools: true,
  supports_audio_input: false,
  supports_image_input: true,
  supports_video_input: false,
  supports_thinking: true,
  max_context_tokens: 131072,
  recommended_max_output_tokens: 4096,
};

function resizeWindow(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

function makeController() {
  return {
    sessions: [
      {
        id: "session-a",
        title: "New chat",
        created_at: "2026-04-09T12:00:00Z",
        updated_at: "2026-04-09T12:00:00Z",
      },
    ],
    activeSession: {
      id: "session-a",
      title: "New chat",
      created_at: "2026-04-09T12:00:00Z",
      updated_at: "2026-04-09T12:00:00Z",
    },
    messages: [],
    settings: {
      auto_start_backend: true,
      user_display_name: "Asha",
      chat: {
        reply_language: "english",
        max_tokens: 4096,
        web_assist_enabled: false,
        generation: {
          thinking_enabled: true,
        },
      },
    },
    backendStatus,
    bootstrapError: null,
    activeModelId: "gemma-4-e2b-it",
    configurableModels: [],
    isBootstrapping: false,
    isGenerating: false,
    isSavingSettings: false,
    isSwitchingModel: false,
    generationStatus: null,
    webSearchEnabled: false,
    webSearchStatus: {
      provider: "searxng",
      available: true,
      running: false,
      healthy: false,
      state: "stopped",
      message: "Local web search is installed and will start on demand.",
      base_url: "http://127.0.0.1:8091",
    },
    thinkingEnabled: true,
    nativeToolSupportAvailable: true,
    webSearchToggleAvailable: true,
    thinkingAvailable: true,
    audioInputAvailable: false,
    createSession: vi.fn(async () => undefined),
    selectSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    cancelGeneration: vi.fn(async () => undefined),
    refreshBackendStatus: vi.fn(async () => backendStatus),
    saveAppSettings: vi.fn(async (_input) => ({
      auto_start_backend: true,
      user_display_name: "Asha",
      chat: {
        reply_language: "english",
        max_tokens: 4096,
        web_assist_enabled: false,
        generation: {
          thinking_enabled: true,
        },
      },
    })),
    setReplyLanguage: vi.fn(async () => undefined),
    selectModel: vi.fn(async () => undefined),
    toggleWebSearch: vi.fn(async () => undefined),
    toggleThinking: vi.fn(async () => undefined),
  };
}

describe("App", () => {
  beforeEach(() => {
    resizeWindow(1400);
    controllerState.mockReset();
    controllerState.mockReturnValue(makeController());
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudoElt) => {
      if (pseudoElt) {
        return {
          getPropertyValue: () => "",
          overflow: "auto",
        } as unknown as CSSStyleDeclaration;
      }
      return nativeGetComputedStyle(element);
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_setup_status") {
        return Promise.resolve({
          readyToChat: true,
          modelDownloaded: true,
          modelDisplayName: "Gemma 4 E2B",
          modelSizeGb: 2.4,
          minRamGb: 4,
          totalRamGb: 16,
          meetsRamMinimum: true,
          runtimeInstalled: true,
          partialDownloadBytes: 0,
        });
      }
      if (command === "list_models") {
        return Promise.resolve([
          {
            id: "gemma-4-e2b-it",
            repo: "",
            filename: "gemma-4-e2b-it.litertlm",
            display_name: "Gemma 4 E2B",
            size_bytes: 2_400_000_000,
            size_gb: 2.4,
            min_ram_gb: 4,
            supports_image_input: true,
            supports_audio_input: false,
            supports_video_input: false,
            supports_thinking: true,
            max_context_tokens: 131072,
            recommended_max_output_tokens: 4096,
          },
        ]);
      }
      if (command === "list_downloaded_model_ids") {
        return Promise.resolve(["gemma-4-e2b-it"]);
      }
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens settings in a drawer while keeping the chat mounted", async () => {
    render(<App />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask Friday anything...")).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));

    await waitFor(() =>
      expect(screen.getByText("Conversation")).not.toBeNull(),
    );
    expect(screen.getByPlaceholderText("Ask Friday anything...")).not.toBeNull();
  });

  it("uses a sidebar drawer on narrow layouts", async () => {
    resizeWindow(900);
    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /show sidebar/i })).not.toBeNull(),
    );

    expect(screen.queryByText("Recent Chats")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /show sidebar/i }));

    await waitFor(() => expect(screen.getByText("Recent Chats")).not.toBeNull());
  });

  it("renders a blocking error panel when bootstrap fails", async () => {
    controllerState.mockReturnValue({
      ...makeController(),
      settings: null,
      backendStatus: null,
      bootstrapError: "Database not initialized",
    });

    render(<App />);

    expect(screen.getByText("Friday could not start")).not.toBeNull();
    expect(screen.getByText("Database not initialized")).not.toBeNull();
    expect(screen.queryByText("Loading Friday...")).toBeNull();
  });
});
