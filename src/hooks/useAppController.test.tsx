import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppController } from "./useAppController";
import type {
  AppUpdateInfo,
  AppSettings,
  AppSettingsInput,
  BackendStatus,
  BootstrapPayload,
  Message,
  Session,
  SessionSelectionResult,
  WebSearchStatus,
} from "../types";

const listeners = new Map<string, Set<(payload: unknown) => void>>();
const invokeMock = vi.fn();

function emitEvent(eventName: string, payload: unknown) {
  listeners.get(eventName)?.forEach((listener) => listener(payload));
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    eventName: string,
    callback: (event: { payload: unknown }) => void,
  ) => {
    const handlers = listeners.get(eventName) ?? new Set();
    const handler = (payload: unknown) => callback({ payload });
    handlers.add(handler);
    listeners.set(eventName, handlers);

    return () => {
      handlers.delete(handler);
    };
  },
}));

const sessionA: Session = {
  id: "session-a",
  title: "New chat",
  created_at: "2026-04-16T04:00:00Z",
  updated_at: "2026-04-16T04:00:00Z",
};

const sessionB: Session = {
  id: "session-b",
  title: "Second chat",
  created_at: "2026-04-16T03:00:00Z",
  updated_at: "2026-04-16T03:00:00Z",
};

const backendStatus: BackendStatus = {
  backend: "LiteRtLm",
  connected: true,
  models: ["gemma-4-e2b-it.litertlm"],
  base_url: "",
  total_ram_gb: 16,
  state: "connected",
  message: "LiteRT-LM 0.10.1 is ready.",
  supports_native_tools: true,
  supports_audio_input: true,
  supports_image_input: true,
  supports_video_input: false,
  supports_thinking: true,
  max_context_tokens: 131072,
  recommended_max_output_tokens: 4096,
};

const readyWebSearchStatus: WebSearchStatus = {
  provider: "searxng",
  available: true,
  running: false,
  healthy: false,
  state: "stopped",
  message: "Local web search is installed and will start on demand.",
  base_url: "http://127.0.0.1:8091",
};

function makeSettings(
  overrides: Partial<AppSettings["chat"]> = {},
): AppSettings {
  return {
    auto_start_backend: true,
    auto_download_updates: true,
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
      ...overrides,
    },
  };
}

describe("useAppController", () => {
  let sessionMessages: Record<string, Message[]>;
  let bootstrapSettings: AppSettings;
  let sessions: Session[];
  let availableAppUpdate: AppUpdateInfo | null;
  let onSendMessageInvoke: ((args: unknown) => void) | null;

  beforeEach(() => {
    listeners.clear();
    invokeMock.mockReset();
    vi.useRealTimers();

    sessions = [sessionA, sessionB];
    sessionMessages = {
      "session-a": [],
      "session-b": [],
    };
    bootstrapSettings = makeSettings();
    availableAppUpdate = null;
    onSendMessageInvoke = null;

    invokeMock.mockImplementation(
      (
        command: string,
        args?: { sessionId?: string; input?: AppSettingsInput },
      ) => {
        switch (command) {
          case "bootstrap_app":
            return Promise.resolve({
              sessions,
              currentSession: sessionA,
              messages: sessionMessages["session-a"],
              settings: bootstrapSettings,
              backendStatus,
              webSearchStatus: readyWebSearchStatus,
              knowledgeStatus: {
                state: "ready",
                message: "Knowledge is ready.",
              },
              knowledgeStats: {
                totalSources: 0,
                readySources: 0,
                totalTextChunks: 0,
                totalImageAssets: 0,
                storageDir: "/tmp/knowledge",
              },
              knowledgeSources: [],
              availableModels: [
                {
                  id: "gemma-4-e2b-it",
                  repo: "",
                  filename: "gemma-4-e2b-it.litertlm",
                  display_name: "Gemma 4 E2B",
                  size_bytes: 2_400_000_000,
                  size_gb: 2.4,
                  min_ram_gb: 4,
                  supports_image_input: true,
                  supports_audio_input: true,
                  supports_video_input: false,
                  supports_thinking: true,
                  max_context_tokens: 131072,
                  recommended_max_output_tokens: 4096,
                },
              ],
              downloadedModelIds: ["gemma-4-e2b-it"],
              activeModel: {
                id: "gemma-4-e2b-it",
                repo: "",
                filename: "gemma-4-e2b-it.litertlm",
                display_name: "Gemma 4 E2B",
                size_bytes: 2_400_000_000,
                size_gb: 2.4,
                min_ram_gb: 4,
                supports_image_input: true,
                supports_audio_input: true,
                supports_video_input: false,
                supports_thinking: true,
                max_context_tokens: 131072,
                recommended_max_output_tokens: 4096,
              },
              serviceDiagnostics: {
                sidecar: {
                  service: "sidecar",
                  state: "ready",
                  message: "LiteRT runtime is ready.",
                  consecutiveFailures: 0,
                },
                searxng: {
                  service: "searxng",
                  state: "ready",
                  message: "Local web search is ready.",
                  consecutiveFailures: 0,
                },
                knowledge: {
                  service: "knowledge",
                  state: "ready",
                  message: "Knowledge is ready.",
                  consecutiveFailures: 0,
                },
              },
            } satisfies BootstrapPayload);
          case "detect_backend":
            return Promise.resolve(backendStatus);
          case "get_web_search_status":
            return Promise.resolve(readyWebSearchStatus);
          case "get_knowledge_status":
            return Promise.resolve({
              state: "ready",
              message: "Knowledge is ready.",
            });
          case "knowledge_list_sources":
            return Promise.resolve([]);
          case "knowledge_stats":
            return Promise.resolve({
              totalSources: 0,
              readySources: 0,
              totalTextChunks: 0,
              totalImageAssets: 0,
              storageDir: "/tmp/knowledge",
            });
          case "list_models":
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
                supports_audio_input: true,
                supports_video_input: false,
                supports_thinking: true,
                max_context_tokens: 131072,
                recommended_max_output_tokens: 4096,
              },
            ]);
          case "get_active_model":
            return Promise.resolve({
              id: "gemma-4-e2b-it",
              display_name: "Gemma 4 E2B",
            });
          case "list_downloaded_model_ids":
            return Promise.resolve(["gemma-4-e2b-it"]);
          case "list_sessions":
            return Promise.resolve(sessions);
          case "select_session": {
            const sessionId = args?.sessionId ?? sessionA.id;
            const session =
              sessions.find((item) => item.id === sessionId) ?? sessionA;
            return Promise.resolve({
              session,
              messages: sessionMessages[sessionId] ?? [],
            } satisfies SessionSelectionResult);
          }
          case "send_message":
            onSendMessageInvoke?.(args);
            return Promise.resolve(undefined);
          case "cancel_generation":
            return Promise.resolve(undefined);
          case "save_settings":
            bootstrapSettings = {
              auto_start_backend: args?.input?.auto_start_backend ?? true,
              auto_download_updates:
                args?.input?.auto_download_updates ?? true,
              user_display_name: args?.input?.user_display_name ?? "Asha",
              theme_mode: args?.input?.theme_mode ?? "light",
              chat: {
                reply_language: args?.input?.chat.reply_language ?? "english",
                max_tokens: args?.input?.chat.max_tokens ?? 4096,
                web_assist_enabled:
                  args?.input?.chat.web_assist_enabled ?? false,
                knowledge_enabled: args?.input?.chat.knowledge_enabled ?? false,
                generation: {
                  temperature: args?.input?.chat.generation.temperature,
                  top_p: args?.input?.chat.generation.top_p,
                  thinking_enabled:
                    args?.input?.chat.generation.thinking_enabled,
                },
              },
            };
            return Promise.resolve(bootstrapSettings);
          case "check_for_app_update":
            return Promise.resolve(availableAppUpdate);
          case "install_app_update":
            return Promise.resolve({
              installed: true,
              version: availableAppUpdate?.version ?? "0.0.0",
              restartRequired: true,
            });
          default:
            return Promise.resolve(undefined);
        }
      },
    );
  });

  async function waitForBootstrap(result: {
    current: ReturnType<typeof useAppController>;
  }) {
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );
  }

  it("bootstraps and normalizes persisted assistant messages into UI-message content", async () => {
    sessionMessages["session-a"] = [
      {
        id: "assistant-1",
        session_id: "session-a",
        role: "assistant",
        content: "Stored answer",
        content_parts: {
          thinking: "Stored reasoning",
          sources: [
            {
              sourceId: "src-1",
              modality: "text",
              displayName: "guide.md",
              locator: "/guide.md",
              score: 0.91,
            },
          ],
        },
        model_used: "gemma-4-e2b-it",
        created_at: "2026-04-16T04:05:00Z",
      },
    ];

    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);

    expect(result.current.messages[0]).toMatchObject({
      content: "Stored answer",
      content_parts: {
        thinking: "Stored reasoning",
      },
      model_used: "gemma-4-e2b-it",
      session_id: "session-a",
    });
  });

  it("auto-installs updates during bootstrap when autodownload is enabled", async () => {
    availableAppUpdate = {
      version: "0.2.0",
      currentVersion: "0.1.0",
      notes: "Stable improvements",
      publishedAt: "2026-04-16T10:00:00Z",
    };

    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);

    await waitFor(() =>
      expect(result.current.installedAppUpdateVersion).toBe("0.2.0"),
    );
    expect(result.current.availableAppUpdate).toBeNull();
    expect(
      invokeMock.mock.calls.some(
        ([command]) => command === "install_app_update",
      ),
    ).toBe(true);
  });

  it("keeps updates manual during bootstrap when autodownload is disabled", async () => {
    bootstrapSettings = {
      ...makeSettings(),
      auto_download_updates: false,
    };
    availableAppUpdate = {
      version: "0.2.0",
      currentVersion: "0.1.0",
      notes: "Stable improvements",
      publishedAt: "2026-04-16T10:00:00Z",
    };

    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);

    await waitFor(() =>
      expect(result.current.availableAppUpdate?.version).toBe("0.2.0"),
    );
    expect(result.current.installedAppUpdateVersion).toBeNull();
    expect(
      invokeMock.mock.calls.some(
        ([command]) => command === "install_app_update",
      ),
    ).toBe(false);
  });

  it("auto-installs a known update when autodownload is enabled later", async () => {
    bootstrapSettings = {
      ...makeSettings(),
      auto_download_updates: false,
    };
    availableAppUpdate = {
      version: "0.2.0",
      currentVersion: "0.1.0",
      notes: "Stable improvements",
      publishedAt: "2026-04-16T10:00:00Z",
    };

    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);
    await waitFor(() =>
      expect(result.current.availableAppUpdate?.version).toBe("0.2.0"),
    );

    await act(async () => {
      await result.current.saveAppSettings({
        auto_start_backend: true,
        auto_download_updates: true,
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
      });
    });

    await waitFor(() =>
      expect(result.current.installedAppUpdateVersion).toBe("0.2.0"),
    );
  });

  it("checks for app updates only once during bootstrap", async () => {
    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);

    expect(
      invokeMock.mock.calls.filter(([command]) => command === "check_for_app_update"),
    ).toHaveLength(1);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(
      invokeMock.mock.calls.filter(([command]) => command === "check_for_app_update"),
    ).toHaveLength(1);
  });

  it("refreshes the persisted session transcript after a streamed turn completes", async () => {
    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);

    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendMessage("Explain the math");
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(true));
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(([command]) => command === "send_message"),
      ).toBe(true),
    );

    sessionMessages["session-a"] = [
      {
        id: "user-db",
        session_id: "session-a",
        role: "user",
        content: "Explain the math",
        created_at: "2026-04-16T04:10:00Z",
      },
      {
        id: "assistant-db",
        session_id: "session-a",
        role: "assistant",
        content: "Persisted final answer",
        content_parts: {
          thinking: "Persisted reasoning",
        },
        model_used: "gemma-4-e2b-it",
        created_at: "2026-04-16T04:10:05Z",
      },
    ];

    act(() => {
      emitEvent("chat-token", {
        sessionId: "session-a",
        token: "Live partial",
        kind: "answer",
      });
      emitEvent("chat-token", {
        sessionId: "session-a",
        token: "Live reasoning",
        kind: "thought",
      });
      emitEvent("chat-done", {
        sessionId: "session-a",
        model: "gemma-4-e2b-it",
        hasContent: true,
        content: "Live partial",
        contentParts: {
          thinking: "Live reasoning",
        },
      });
    });

    await act(async () => {
      await sendPromise;
    });

    await waitFor(() =>
      expect(
        result.current.messages[result.current.messages.length - 1],
      ).toMatchObject({
        content: "Persisted final answer",
        content_parts: { thinking: "Persisted reasoning" },
      }),
    );
    expect(result.current.isGenerating).toBe(false);
  });

  it("appends an assistant error bubble when the backend emits chat-error", async () => {
    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);

    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendMessage("This should fail");
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(true));
    act(() => {
      emitEvent("chat-error", {
        sessionId: "session-a",
        message: "backend unavailable",
      });
    });

    await act(async () => {
      await sendPromise;
    });

    await waitFor(() =>
      expect(
        result.current.messages[result.current.messages.length - 1]?.content,
      ).toContain("backend unavailable"),
    );
  });

  it("refreshes session state after a failed request and preserves the error bubble", async () => {
    onSendMessageInvoke = (args) => {
      const request = (
        args as
          | {
              request?: {
                sessionId?: string;
                message?: string;
              };
            }
          | undefined
      )?.request;
      const sessionId = request?.sessionId ?? "session-a";
      const message = request?.message ?? "Untitled";
      const persistedUserMessage: Message = {
        id: "user-persisted-1",
        session_id: sessionId,
        role: "user",
        content: message,
        content_parts: null,
        model_used: null,
        tokens_used: null,
        latency_ms: null,
        created_at: "2026-04-16T04:05:00Z",
      };

      sessionMessages[sessionId] = [persistedUserMessage];
      sessions = sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              title: message,
              updated_at: "2026-04-16T04:05:00Z",
            }
          : session,
      );
    };

    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);

    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendMessage("Failure should still retitle");
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(true));
    act(() => {
      emitEvent("chat-error", {
        sessionId: "session-a",
        message: "backend unavailable",
      });
    });

    await act(async () => {
      await sendPromise;
    });

    await waitFor(() =>
      expect(result.current.activeSession?.title).toBe(
        "Failure should still retitle",
      ),
    );
    expect(result.current.sessions[0]?.title).toBe(
      "Failure should still retitle",
    );
    expect(
      result.current.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.includes("backend unavailable"),
      ),
    ).toBe(true);
  });

  it("tracks web-search lifecycle and tool activity status while streaming", async () => {
    bootstrapSettings = makeSettings({
      web_assist_enabled: true,
    });

    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);

    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendMessage("Search for the answer");
    });

    await waitFor(() =>
      expect(result.current.generationStatus).toBe("Starting web search…"),
    );

    act(() => {
      emitEvent("web-search-status", {
        ...readyWebSearchStatus,
        state: "ready",
        message: "Web search ready.",
      });
    });
    await waitFor(() =>
      expect(result.current.generationStatus).toBe("Friday is thinking…"),
    );

    act(() => {
      emitEvent("tool-call-start", {
        sessionId: "session-a",
        name: "web_fetch",
        args: {},
      });
    });
    await waitFor(() =>
      expect(result.current.generationStatus).toBe("Reading the page…"),
    );

    act(() => {
      emitEvent("tool-call-result", {
        sessionId: "session-a",
        name: "web_fetch",
        result: {},
      });
    });
    await waitFor(() =>
      expect(result.current.generationStatus).toBe("Friday is thinking…"),
    );

    act(() => {
      emitEvent("chat-done", {
        sessionId: "session-a",
        model: "gemma-4-e2b-it",
        hasContent: true,
        content: "Done",
        contentParts: null,
      });
    });

    await act(async () => {
      await sendPromise;
    });
  });

  it("blocks session switching while generation is in progress", async () => {
    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);

    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendMessage("Keep streaming");
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(true));

    await act(async () => {
      await result.current.selectSession("session-b");
    });

    expect(result.current.activeSession?.id).toBe("session-a");
    expect(
      invokeMock.mock.calls.some(
        ([command, args]) =>
          command === "select_session" &&
          (args as { sessionId?: string } | undefined)?.sessionId ===
            "session-b",
      ),
    ).toBe(false);

    act(() => {
      emitEvent("chat-done", {
        sessionId: "session-a",
        model: "gemma-4-e2b-it",
        hasContent: true,
        content: "Done",
        contentParts: null,
      });
    });

    await act(async () => {
      await sendPromise;
    });
  });

  it("persists the thinking toggle through save_settings", async () => {
    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);

    await act(async () => {
      await result.current.toggleThinking();
    });

    expect(result.current.thinkingEnabled).toBe(false);
    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === "save_settings" &&
          (payload as { input?: AppSettingsInput } | undefined)?.input?.chat
            ?.generation?.thinking_enabled === false,
      ),
    ).toBe(true);
  });

  it("surfaces cancel RPC failures from cancel_generation", async () => {
    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);

    invokeMock.mockImplementation((command: string) => {
      if (command === "cancel_generation") {
        return Promise.resolve({
          status: "failed",
          error_code: "cancel_rpc_failed",
          message: "Failed to cancel active generation: daemon unavailable",
        });
      }
      return Promise.resolve(undefined);
    });

    await act(async () => {
      await result.current.cancelGeneration();
    });

    expect(result.current.generationStatus).toBe(
      "Failed to cancel active generation: daemon unavailable",
    );
  });

  it("clears stopping state when cancel_generation reports not_running", async () => {
    const { result } = renderHook(() => useAppController());
    await waitForBootstrap(result);

    invokeMock.mockImplementation((command: string) => {
      if (command === "cancel_generation") {
        return Promise.resolve({
          status: "not_running",
        });
      }
      return Promise.resolve(undefined);
    });

    await act(async () => {
      await result.current.cancelGeneration();
    });

    expect(result.current.generationStatus).toBeNull();
  });
});
