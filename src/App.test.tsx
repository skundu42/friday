import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { AppUpdateInfo, BackendStatus } from "./types";

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
      theme_mode: "light",
      chat: {
        reply_language: "english",
        max_tokens: 4096,
        web_assist_enabled: false,
        knowledge_enabled: false,
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
    knowledgeEnabled: false,
    webSearchStatus: {
      provider: "searxng",
      available: true,
      running: false,
      healthy: false,
      state: "stopped",
      message: "Local web search is installed and will start on demand.",
      base_url: "http://127.0.0.1:8091",
    },
    knowledgeStatus: {
      state: "ready",
      message: "Knowledge is ready.",
    },
    knowledgeSources: [],
    knowledgeStats: {
      totalSources: 2,
      readySources: 2,
      totalTextChunks: 12,
      totalImageAssets: 1,
      storageDir: "/Users/sk/Library/Application Support/com.friday.app/rag",
    },
    thinkingEnabled: true,
    availableAppUpdate: null as AppUpdateInfo | null,
    installedAppUpdateVersion: null,
    appUpdateError: null,
    isInstallingAppUpdate: false,
    nativeToolSupportAvailable: true,
    webSearchToggleAvailable: true,
    knowledgeToggleAvailable: true,
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
      theme_mode: "light",
      chat: {
        reply_language: "english",
        max_tokens: 4096,
        web_assist_enabled: false,
        knowledge_enabled: false,
        generation: {
          thinking_enabled: true,
        },
      },
    })),
    setReplyLanguage: vi.fn(async () => undefined),
    selectModel: vi.fn(async () => undefined),
    refreshKnowledge: vi.fn(async () => undefined),
    toggleWebSearch: vi.fn(async () => undefined),
    toggleKnowledge: vi.fn(async () => undefined),
    toggleThinking: vi.fn(async () => undefined),
    ingestKnowledgeFile: vi.fn(async () => undefined),
    ingestKnowledgeUrl: vi.fn(async () => undefined),
    deleteKnowledgeSource: vi.fn(async () => undefined),
    installAppUpdate: vi.fn(async () => ({
      installed: true,
      version: "0.2.0",
      restartRequired: true,
    })),
    restartApp: vi.fn(async () => undefined),
    dismissAppUpdate: vi.fn(),
    clearAppUpdateError: vi.fn(),
    clearInstalledAppUpdateVersion: vi.fn(),
  };
}

function getChatView() {
  return screen.getByPlaceholderText("Ask Friday anything...").closest(".app-view");
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

  it("opens settings as a full page view and returns to chat", async () => {
    const controller = makeController();
    controllerState.mockReturnValue(controller);

    render(<App />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask Friday anything...")).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 3, name: "Conversation" }),
      ).not.toBeNull(),
    );
    expect(getChatView()?.classList.contains("is-hidden")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));

    await waitFor(() =>
      expect(getChatView()?.classList.contains("is-hidden")).toBe(false),
    );
    expect(controller.refreshBackendStatus).toHaveBeenCalledTimes(1);
  });

  it("shows update banner and triggers install action", async () => {
    const controller = makeController();
    controller.availableAppUpdate = {
      version: "0.2.0",
      currentVersion: "0.1.0",
      notes: "Stable improvements",
    };
    controllerState.mockReturnValue(controller);

    render(<App />);

    await waitFor(() =>
      expect(screen.getByText("Update available: v0.2.0")).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: /download & install/i }));
    expect(controller.installAppUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows setup wizard when setup status load fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_setup_status") {
        return Promise.reject(new Error("setup unavailable"));
      }
      if (command === "list_models") {
        return Promise.resolve([]);
      }
      if (command === "list_downloaded_model_ids") {
        return Promise.resolve([]);
      }
      return Promise.resolve(undefined);
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Welcome to Friday")).not.toBeNull());
  });

  it("opens the Knowledge page from the sidebar", async () => {
    const controller = makeController();
    controllerState.mockReturnValue(controller);

    render(<App />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask Friday anything...")).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: /open knowledge/i }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 3, name: "Knowledge" })).not.toBeNull(),
    );
    expect(controller.refreshKnowledge).toHaveBeenCalledTimes(1);
    expect(getChatView()?.classList.contains("is-hidden")).toBe(true);
    expect(screen.queryByRole("button", { name: /add folder/i })).toBeNull();
    expect(screen.queryByText(/stored under/i)).toBeNull();
    expect(screen.queryByText("How Friday uses it")).toBeNull();
  });

  it("returns to chat when creating a new chat from settings", async () => {
    const controller = makeController();
    controllerState.mockReturnValue(controller);

    render(<App />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask Friday anything...")).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 3, name: "Conversation" }),
      ).not.toBeNull(),
    );
    expect(getChatView()?.classList.contains("is-hidden")).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: /new chat/i })[0]!);

    await waitFor(() =>
      expect(getChatView()?.classList.contains("is-hidden")).toBe(false),
    );
    expect(controller.createSession).toHaveBeenCalledTimes(1);
    expect(controller.refreshBackendStatus).toHaveBeenCalledTimes(1);
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

  it("applies the persisted dark mode to document chrome", async () => {
    const controller = makeController();
    controller.settings.theme_mode = "dark";
    controllerState.mockReturnValue(controller);

    const { unmount } = render(<App />);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask Friday anything...")).not.toBeNull(),
    );

    expect(document.body.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    unmount();

    expect(document.body.dataset.theme).toBeUndefined();
    expect(document.documentElement.style.colorScheme).toBe("");
  });
});
