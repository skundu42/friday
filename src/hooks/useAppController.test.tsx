import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppController } from "./useAppController";
import type {
  AppSettings,
  AppSettingsInput,
  BackendStatus,
  BootstrapPayload,
  SessionSelectionResult,
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
  supports_thinking: false,
  max_context_tokens: 131072,
  recommended_max_output_tokens: 4096,
};

const settings: AppSettings = {
  auto_start_backend: true,
  user_display_name: "Asha",
  chat: {
    reply_language: "english",
    max_tokens: 4096,
    web_assist_enabled: false,
    generation: {},
  },
};

function makeSession(
  id: string,
  title: string,
  createdAt: string,
  updatedAt = createdAt,
) {
  return {
    id,
    title,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

const bootstrapPayload: BootstrapPayload = {
  sessions: [
    makeSession("session-a", "New chat", "2026-04-09T12:00:00Z"),
    makeSession("session-b", "Second chat", "2026-04-09T11:00:00Z"),
  ],
  currentSession: makeSession("session-a", "New chat", "2026-04-09T12:00:00Z"),
  messages: [],
  settings,
  backendStatus: backendStatus,
};

describe("useAppController", () => {
  beforeEach(() => {
    listeners.clear();
    invokeMock.mockReset();
    vi.useRealTimers();
    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      if (command === "list_sessions") {
        return Promise.resolve(bootstrapPayload.sessions);
      }
      if (command === "select_session") {
        return Promise.resolve({
          session: bootstrapPayload.currentSession,
          messages: bootstrapPayload.messages,
        });
      }
      return Promise.resolve(undefined);
    });
  });

  it("bootstraps the active session, settings, and backend state", async () => {
    const { result } = renderHook(() => useAppController());

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.settings?.chat.reply_language).toBe("english");
    expect(result.current.currentModel).toBe("Gemma 4 E2B");
    expect(result.current.messages).toEqual([]);
  });

  it("warms the backend after bootstrap when auto-start is enabled and the daemon is idle", async () => {
    const readyBackendStatus: BackendStatus = {
      ...backendStatus,
      connected: false,
      state: "ready",
      message: "LiteRT-LM is ready to start.",
    };
    const readyBootstrapPayload: BootstrapPayload = {
      ...bootstrapPayload,
      backendStatus: readyBackendStatus,
    };

    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") {
        return Promise.resolve(readyBootstrapPayload);
      }
      if (command === "warm_backend") {
        return Promise.resolve(backendStatus);
      }
      if (command === "detect_backend") {
        return Promise.resolve(readyBackendStatus);
      }
      return Promise.resolve(undefined);
    });

    renderHook(() => useAppController());

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(([command]) => command === "warm_backend"),
      ).toBe(true),
    );
  });

  it("selects a different session without reloading", async () => {
    const selection: SessionSelectionResult = {
      session: makeSession("session-b", "Second chat", "2026-04-09T11:00:00Z"),
      messages: [
        {
          id: "m-1",
          session_id: "session-b",
          role: "assistant",
          content: "Loaded from storage",
          created_at: "2026-04-09T11:05:00Z",
        },
      ],
    };

    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
      if (command === "select_session") return Promise.resolve(selection);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    await act(async () => {
      await result.current.selectSession("session-b");
    });

    expect(result.current.activeSession?.id).toBe("session-b");
    expect(result.current.messages[0]?.content).toBe("Loaded from storage");
  });

  it("removes an empty assistant placeholder and appends an error when send fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      if (command === "send_message")
        return Promise.reject(new Error("backend unavailable"));
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    await act(async () => {
      await result.current.sendMessage("Hello Friday");
    });

    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === "send_message" && payload?.sessionId === "session-a",
      ),
    ).toBe(true);
    expect(result.current.isGenerating).toBe(false);
    expect(
      result.current.messages.some((message) => message.content === ""),
    ).toBe(false);
    expect(
      result.current.messages[result.current.messages.length - 1]?.content,
    ).toContain("backend unavailable");
  });

  it("reloads persisted messages when send completes without stream events", async () => {
    invokeMock.mockImplementation(
      (command: string, args?: { sessionId?: string }) => {
        if (command === "bootstrap_app")
          return Promise.resolve(bootstrapPayload);
        if (command === "detect_backend") return Promise.resolve(backendStatus);
        if (command === "send_message") return Promise.resolve(undefined);
        if (command === "select_session" && args?.sessionId === "session-a") {
          return Promise.resolve({
            session: makeSession(
              "session-a",
              "Hello Friday",
              "2026-04-09T12:00:00Z",
              "2026-04-09T12:01:05Z",
            ),
            messages: [
              {
                id: "m-user",
                session_id: "session-a",
                role: "user",
                content: "Hello Friday",
                created_at: "2026-04-09T12:01:00Z",
              },
              {
                id: "m-assistant",
                session_id: "session-a",
                role: "assistant",
                content: "Persisted answer",
                created_at: "2026-04-09T12:01:05Z",
              },
            ],
          });
        }
        if (command === "list_sessions") {
          return Promise.resolve([
            makeSession(
              "session-a",
              "Hello Friday",
              "2026-04-09T12:00:00Z",
              "2026-04-09T12:01:05Z",
            ),
            makeSession("session-b", "Second chat", "2026-04-09T11:00:00Z"),
          ]);
        }
        return Promise.resolve(undefined);
      },
    );

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    await act(async () => {
      await result.current.sendMessage("Hello Friday");
    });

    expect(result.current.isGenerating).toBe(false);
    expect(
      result.current.messages.some((message) => message.content === ""),
    ).toBe(false);
    expect(
      result.current.messages[result.current.messages.length - 1]?.content,
    ).toBe("Persisted answer");
  });

  it("buffers streamed tokens and preserves the assistant content", async () => {
    let resolveSend: (() => void) | undefined;
    invokeMock.mockImplementation(
      (command: string, args?: { sessionId?: string }) => {
        if (command === "bootstrap_app")
          return Promise.resolve(bootstrapPayload);
        if (command === "detect_backend") return Promise.resolve(backendStatus);
        if (command === "send_message") {
          return new Promise<void>((resolve) => {
            resolveSend = resolve;
          });
        }
        if (command === "select_session" && args?.sessionId === "session-a") {
          return Promise.resolve({
            session: makeSession(
              "session-a",
              "Hello Friday",
              "2026-04-09T12:00:00Z",
              "2026-04-09T12:01:05Z",
            ),
            messages: [
              {
                id: "m-user",
                session_id: "session-a",
                role: "user",
                content: "Hello Friday",
                created_at: "2026-04-09T12:01:00Z",
              },
              {
                id: "m-assistant",
                session_id: "session-a",
                role: "assistant",
                content: "Hello there",
                created_at: "2026-04-09T12:01:05Z",
              },
            ],
          });
        }
        if (command === "list_sessions") {
          return Promise.resolve([
            makeSession(
              "session-a",
              "Hello Friday",
              "2026-04-09T12:00:00Z",
              "2026-04-09T12:01:05Z",
            ),
            makeSession("session-b", "Second chat", "2026-04-09T11:00:00Z"),
          ]);
        }
        return Promise.resolve(undefined);
      },
    );

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    await act(async () => {
      void result.current.sendMessage("Hello Friday");
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(true));

    act(() => {
      emitEvent("chat-token", { sessionId: "session-b", token: "ignored" });
      emitEvent("chat-token", { sessionId: "session-a", token: "Hello" });
      emitEvent("chat-token", { sessionId: "session-a", token: " there" });
    });

    expect(
      result.current.messages.some(
        (message) => message.role === "assistant" && message.content === "",
      ),
    ).toBe(false);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });

    expect(
      result.current.messages[result.current.messages.length - 1]?.content,
    ).toBe("Hello there");

    act(() => {
      emitEvent("chat-done", {
        sessionId: "session-a",
        model: "gemma-4-e2b-it.litertlm",
        hasContent: true,
      });
    });

    await act(async () => {
      resolveSend?.();
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));
    expect(
      result.current.messages[result.current.messages.length - 1]?.content,
    ).toBe("Hello there");
  });

  it("cancels generation without leaving a blank assistant bubble", async () => {
    let resolveSend: (() => void) | undefined;
    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      if (command === "send_message") {
        return new Promise<void>((resolve) => {
          resolveSend = resolve;
        });
      }
      if (command === "list_sessions") return Promise.resolve(bootstrapPayload.sessions);
      if (command === "select_session") {
        return Promise.resolve({
          session: bootstrapPayload.currentSession,
          messages: [],
        });
      }
      if (command === "cancel_generation") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    await act(async () => {
      void result.current.sendMessage("Cancel me");
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(true));
    expect(
      result.current.messages.some(
        (message) => message.role === "assistant" && message.content === "",
      ),
    ).toBe(false);

    await act(async () => {
      await result.current.cancelGeneration();
    });

    expect(result.current.isGenerating).toBe(true);

    await act(async () => {
      await result.current.sendMessage("Retry too early");
    });

    expect(
      invokeMock.mock.calls.filter(([command]) => command === "send_message"),
    ).toHaveLength(1);

    act(() => {
      emitEvent("chat-done", {
        sessionId: "session-a",
        model: "gemma-4-e2b-it.litertlm",
        cancelled: true,
        hasContent: false,
      });
    });

    await act(async () => {
      resolveSend?.();
    });

    expect(result.current.isGenerating).toBe(false);
    expect(
      result.current.messages.some(
        (message) => message.role === "assistant" && message.content === "",
      ),
    ).toBe(false);
  });

  it("serializes audio attachments with a persisted path", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      if (command === "send_message") return Promise.resolve(undefined);
      if (command === "list_sessions") return Promise.resolve(bootstrapPayload.sessions);
      if (command === "select_session") {
        return Promise.resolve({
          session: bootstrapPayload.currentSession,
          messages: [],
        });
      }
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    await act(async () => {
      await result.current.sendMessage("Summarize this recording", [
        {
          path: "/tmp/test-audio.wav",
          name: "test-audio.wav",
          mimeType: "audio/wav",
          sizeBytes: 128,
          content: { path: "/tmp/test-audio.wav" },
          status: "ready",
        },
      ]);
    });

    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === "send_message" &&
          payload?.sessionId === "session-a" &&
          payload?.attachments?.[0]?.path === "/tmp/test-audio.wav" &&
          payload?.attachments?.[0]?.mimeType === "audio/wav",
      ),
    ).toBe(true);
  });

  it("ignores attachments that are not ready yet", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      if (command === "send_message") return Promise.resolve(undefined);
      if (command === "list_sessions") return Promise.resolve(bootstrapPayload.sessions);
      if (command === "select_session") {
        return Promise.resolve({
          session: bootstrapPayload.currentSession,
          messages: [],
        });
      }
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    await act(async () => {
      await result.current.sendMessage("What is in this image?", [
        {
          path: "/tmp/photo.png",
          name: "photo.png",
          mimeType: "image/png",
          sizeBytes: 128,
          content: { dataUrl: "data:image/png;base64,ZmFrZQ==" },
          status: "loading",
        },
      ]);
    });

    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === "send_message" &&
          payload?.sessionId === "session-a" &&
          payload?.message === "What is in this image?" &&
          payload?.attachments === null,
      ),
    ).toBe(true);
  });

  it("saves settings and refreshes backend state", async () => {
    const updatedSettings: AppSettings = {
      auto_start_backend: false,
      user_display_name: "Asha",
      chat: {
        reply_language: "hindi",
        max_tokens: 6144,
        web_assist_enabled: true,
        generation: {},
      },
    };

    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
      if (command === "save_settings") return Promise.resolve(updatedSettings);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.settings?.chat.reply_language).toBe("english"),
    );

    await act(async () => {
      await result.current.saveAppSettings({
        auto_start_backend: false,
        user_display_name: "Asha",
        chat: {
          reply_language: "hindi",
          max_tokens: 6144,
          web_assist_enabled: true,
          generation: {},
        },
      });
    });

    expect(result.current.settings?.chat.reply_language).toBe("hindi");
    expect(result.current.settings?.chat.max_tokens).toBe(6144);
  });

  it("serializes settings saves so later changes are applied last", async () => {
    const firstSaved: AppSettings = {
      auto_start_backend: true,
      user_display_name: "Asha",
      chat: {
        reply_language: "hindi",
        max_tokens: 4096,
        web_assist_enabled: false,
        generation: {},
      },
    };
    const secondSaved: AppSettings = {
      auto_start_backend: true,
      user_display_name: "Asha",
      chat: {
        reply_language: "hindi",
        max_tokens: 8192,
        web_assist_enabled: true,
        generation: {},
      },
    };
    const saveResolvers: Array<(value: AppSettings) => void> = [];

    invokeMock.mockImplementation(
      (command: string, args?: { input?: AppSettings }) => {
        if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
        if (command === "detect_backend") return Promise.resolve(backendStatus);
        if (command === "save_settings") {
          return new Promise<AppSettings>((resolve) => {
            saveResolvers.push(resolve);
          });
        }
        return Promise.resolve(undefined);
      },
    );

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.settings?.chat.reply_language).toBe("english"),
    );

    let firstSavePromise: Promise<AppSettings> | undefined;
    let secondSavePromise: Promise<AppSettings> | undefined;

    act(() => {
      firstSavePromise = result.current.saveAppSettings({
        auto_start_backend: true,
        user_display_name: "Asha",
        chat: {
          reply_language: "hindi",
          max_tokens: 4096,
          web_assist_enabled: false,
          generation: {},
        },
      });
      secondSavePromise = result.current.saveAppSettings({
        auto_start_backend: true,
        user_display_name: "Asha",
        chat: {
          reply_language: "hindi",
          max_tokens: 8192,
          web_assist_enabled: true,
          generation: {},
        },
      });
    });

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "save_settings"),
      ).toHaveLength(1),
    );
    expect(result.current.isSavingSettings).toBe(true);

    await act(async () => {
      saveResolvers[0](firstSaved);
      await firstSavePromise;
    });

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "save_settings"),
      ).toHaveLength(2),
    );

    await act(async () => {
      saveResolvers[1](secondSaved);
      await secondSavePromise;
    });

    expect(result.current.settings?.chat.reply_language).toBe("hindi");
    expect(result.current.settings?.chat.max_tokens).toBe(8192);
    expect(result.current.webSearchEnabled).toBe(true);
    expect(result.current.isSavingSettings).toBe(false);
  });

  it("merges queued settings saves against the latest desired state", async () => {
    const firstSaved: AppSettings = {
      ...settings,
      chat: {
        ...settings.chat,
        web_assist_enabled: true,
      },
    };
    const secondSaved: AppSettings = {
      ...settings,
      chat: {
        ...settings.chat,
        web_assist_enabled: true,
        generation: {
          thinking_enabled: true,
        },
      },
    };
    const saveResolvers: Array<(value: AppSettings) => void> = [];

    invokeMock.mockImplementation(
      (command: string, args?: { input?: AppSettingsInput }) => {
        if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
        if (command === "detect_backend") return Promise.resolve(backendStatus);
        if (command === "save_settings") {
          return new Promise<AppSettings>((resolve) => {
            saveResolvers.push(resolve);
          });
        }
        return Promise.resolve(undefined);
      },
    );

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.settings?.chat.reply_language).toBe("english"),
    );

    let firstSavePromise: Promise<AppSettings> | undefined;
    let secondSavePromise: Promise<AppSettings> | undefined;

    act(() => {
      firstSavePromise = result.current.saveAppSettings({
        auto_start_backend: true,
        user_display_name: "Asha",
        chat: {
          reply_language: "english",
          max_tokens: 4096,
          web_assist_enabled: true,
          generation: {},
        },
      });
      secondSavePromise = result.current.saveAppSettings({
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
      });
    });

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "save_settings"),
      ).toHaveLength(1),
    );

    await act(async () => {
      saveResolvers[0](firstSaved);
      await firstSavePromise;
    });

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "save_settings"),
      ).toHaveLength(2),
    );

    expect(
      invokeMock.mock.calls.filter(([command]) => command === "save_settings")[1]?.[1],
    ).toEqual({
      input: {
        auto_start_backend: true,
        user_display_name: "Asha",
        chat: {
          reply_language: "english",
          max_tokens: 4096,
          web_assist_enabled: true,
          generation: {
            thinking_enabled: true,
          },
        },
      },
    });

    await act(async () => {
      saveResolvers[1](secondSaved);
      await secondSavePromise;
    });

    expect(result.current.webSearchEnabled).toBe(true);
    expect(result.current.thinkingEnabled).toBe(true);
  });

  it("hydrates persisted web assist after bootstrap", async () => {
    const payload: BootstrapPayload = {
      ...bootstrapPayload,
      settings: {
        ...settings,
        chat: {
          ...settings.chat,
          web_assist_enabled: true,
        },
      },
    };

    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(payload);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    expect(result.current.webSearchEnabled).toBe(true);
  });

  it("preserves the saved web assist preference across backend availability changes", async () => {
    const unsupportedBackendStatus: BackendStatus = {
      ...backendStatus,
      supports_native_tools: false,
    };
    const payload: BootstrapPayload = {
      ...bootstrapPayload,
      settings: {
        ...settings,
        chat: {
          ...settings.chat,
          web_assist_enabled: true,
        },
      },
      backendStatus: unsupportedBackendStatus,
    };

    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(payload);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    expect(result.current.webSearchEnabled).toBe(true);
    expect(result.current.nativeToolSupportAvailable).toBe(false);

    await act(async () => {
      await result.current.refreshBackendStatus();
    });

    expect(result.current.webSearchEnabled).toBe(true);
    expect(result.current.nativeToolSupportAvailable).toBe(true);
  });

  it("refreshes backend status without reloading model inventory after chat completion", async () => {
    let resolveSend: (() => void) | undefined;

    invokeMock.mockImplementation(
      (command: string, args?: { sessionId?: string }) => {
        if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
        if (command === "detect_backend") return Promise.resolve(backendStatus);
        if (command === "list_models") {
          return Promise.resolve([
            {
              id: "gemma-4-e2b-it",
              display_name: "Gemma 4 E2B",
            },
          ]);
        }
        if (command === "get_active_model") {
          return Promise.resolve({
            id: "gemma-4-e2b-it",
            display_name: "Gemma 4 E2B",
          });
        }
        if (command === "list_downloaded_model_ids") {
          return Promise.resolve(["gemma-4-e2b-it"]);
        }
        if (command === "send_message") {
          return new Promise<void>((resolve) => {
            resolveSend = resolve;
          });
        }
        if (command === "select_session" && args?.sessionId === "session-a") {
          return Promise.resolve({
            session: bootstrapPayload.currentSession,
            messages: [
              {
                id: "m-user",
                session_id: "session-a",
                role: "user",
                content: "Hello Friday",
                created_at: "2026-04-09T12:01:00Z",
              },
              {
                id: "m-assistant",
                session_id: "session-a",
                role: "assistant",
                content: "Done",
                created_at: "2026-04-09T12:01:05Z",
              },
            ],
          });
        }
        if (command === "list_sessions") {
          return Promise.resolve(bootstrapPayload.sessions);
        }
        return Promise.resolve(undefined);
      },
    );

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    invokeMock.mockClear();

    await act(async () => {
      void result.current.sendMessage("Hello Friday");
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(true));

    act(() => {
      emitEvent("chat-done", {
        sessionId: "session-a",
        model: "gemma-4-e2b-it.litertlm",
        hasContent: true,
      });
    });

    await act(async () => {
      resolveSend?.();
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(false));
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "detect_backend"),
    ).toHaveLength(1);
    expect(
      invokeMock.mock.calls.some(([command]) => command === "list_models"),
    ).toBe(false);
    expect(
      invokeMock.mock.calls.some(([command]) => command === "get_active_model"),
    ).toBe(false);
    expect(
      invokeMock.mock.calls.some(
        ([command]) => command === "list_downloaded_model_ids",
      ),
    ).toBe(false);
  });

  it("hydrates persisted thinking after bootstrap", async () => {
    const payload: BootstrapPayload = {
      ...bootstrapPayload,
      settings: {
        ...settings,
        chat: {
          ...settings.chat,
          generation: {
            thinking_enabled: true,
          },
        },
      },
    };

    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(payload);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    expect(result.current.thinkingEnabled).toBe(true);
  });

  it("does not request thinking when the active backend does not support it", async () => {
    const payload: BootstrapPayload = {
      ...bootstrapPayload,
      settings: {
        ...settings,
        chat: {
          ...settings.chat,
          generation: {
            thinking_enabled: true,
          },
        },
      },
    };

    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(payload);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      if (command === "send_message") return Promise.resolve(undefined);
      if (command === "list_sessions") return Promise.resolve(bootstrapPayload.sessions);
      if (command === "select_session") {
        return Promise.resolve({
          session: bootstrapPayload.currentSession,
          messages: [],
        });
      }
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    expect(result.current.thinkingEnabled).toBe(true);
    expect(result.current.thinkingAvailable).toBe(false);

    await act(async () => {
      await result.current.sendMessage("Hello Friday");
    });

    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === "send_message" &&
          payload?.sessionId === "session-a" &&
          payload?.thinkingEnabled === false,
      ),
    ).toBe(true);
  });

  it("persists the web assist toggle through saved settings", async () => {
    const savedSettings: AppSettings = {
      ...settings,
      chat: {
        ...settings.chat,
        web_assist_enabled: true,
      },
    };

    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
      if (command === "save_settings") return Promise.resolve(savedSettings);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    await act(async () => {
      await result.current.toggleWebSearch();
    });

    expect(result.current.webSearchEnabled).toBe(true);
    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === "save_settings" &&
          payload?.input?.chat?.web_assist_enabled === true,
      ),
    ).toBe(true);
  });

  it("persists the thinking toggle through saved settings", async () => {
    const savedSettings: AppSettings = {
      ...settings,
      chat: {
        ...settings.chat,
        generation: {
          thinking_enabled: true,
        },
      },
    };

    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
      if (command === "save_settings") return Promise.resolve(savedSettings);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());

    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    await act(async () => {
      await result.current.toggleThinking();
    });

    expect(result.current.thinkingEnabled).toBe(true);
    expect(
      invokeMock.mock.calls.some(
        ([command, payload]) =>
          command === "save_settings" &&
          payload?.input?.chat?.generation?.thinking_enabled === true,
      ),
    ).toBe(true);
  });

  it("blocks session switching while generation is in progress", async () => {
    let resolveSend: (() => void) | undefined;
    const selection: SessionSelectionResult = {
      session: makeSession("session-b", "Second chat", "2026-04-09T11:00:00Z"),
      messages: [],
    };

    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      if (command === "send_message") {
        return new Promise<void>((resolve) => {
          resolveSend = resolve;
        });
      }
      if (command === "select_session") return Promise.resolve(selection);
      if (command === "list_sessions") return Promise.resolve(bootstrapPayload.sessions);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    await act(async () => {
      void result.current.sendMessage("Keep me here");
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(true));

    await act(async () => {
      await result.current.selectSession("session-b");
    });

    expect(result.current.activeSession?.id).toBe("session-a");
    expect(
      invokeMock.mock.calls.some(([command]) => command === "select_session"),
    ).toBe(false);

    await act(async () => {
      resolveSend?.();
    });
  });

  it("blocks session deletion while generation is in progress", async () => {
    let resolveSend: (() => void) | undefined;

    invokeMock.mockImplementation((command: string) => {
      if (command === "bootstrap_app") return Promise.resolve(bootstrapPayload);
      if (command === "detect_backend") return Promise.resolve(backendStatus);
      if (command === "send_message") {
        return new Promise<void>((resolve) => {
          resolveSend = resolve;
        });
      }
      if (command === "list_sessions") return Promise.resolve(bootstrapPayload.sessions);
      if (command === "select_session") {
        return Promise.resolve({
          session: bootstrapPayload.currentSession,
          messages: [],
        });
      }
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useAppController());
    await waitFor(() =>
      expect(result.current.activeSession?.id).toBe("session-a"),
    );

    await act(async () => {
      void result.current.sendMessage("Do not delete");
    });

    await waitFor(() => expect(result.current.isGenerating).toBe(true));

    await act(async () => {
      await result.current.deleteSession("session-a");
    });

    expect(
      invokeMock.mock.calls.some(([command]) => command === "delete_session"),
    ).toBe(false);

    await act(async () => {
      resolveSend?.();
    });
  });
});
