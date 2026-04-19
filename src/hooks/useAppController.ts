import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { notification } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  makeFridayAssistantMessage,
  normalizeFridayMessage,
  normalizeFridayMessages,
  toFridayChatMessages,
} from "../lib/friday-chat";
import { TauriChatTransport } from "../lib/tauri-chat-transport";
import type {
  AppUpdateInfo,
  AppUpdateInstallResult,
  AppSettings,
  AppSettingsInput,
  BackendStatus,
  BootstrapPayload,
  CancelGenerationResponse,
  FileAttachment,
  FridayChatMessage,
  FridayUIMessage,
  KnowledgeIngestProgress,
  KnowledgeSource,
  KnowledgeStats,
  KnowledgeStatus,
  Message,
  ModelInfo,
  ReplyLanguage,
  ServiceDiagnosticsBundle,
  Session,
  SessionSelectionResult,
  ToolCallEvent,
  ToolResultEvent,
  WebSearchState,
  WebSearchStatus,
} from "../types";

function makeId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function formatModelLabel(model: string) {
  if (model === "gemma-4-e2b-it") return "Gemma 4 E2B";
  if (model === "gemma-4-e2b-it.litertlm") return "Gemma 4 E2B";
  if (model === "gemma-4-e4b-it") return "Gemma 4 E4B";
  if (model === "gemma-4-e4b-it.litertlm") return "Gemma 4 E4B";
  if (!model) return "—";
  return model;
}

function toErrorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong while processing your request.";
}

function unavailableWebSearchStatus(
  message = "Web search is unavailable.",
): WebSearchStatus {
  return {
    provider: "searxng",
    available: false,
    running: false,
    healthy: false,
    state: "unavailable",
    message,
    base_url: "http://127.0.0.1:8091",
  };
}

function unavailableKnowledgeStatus(
  message = "Knowledge is unavailable.",
): KnowledgeStatus {
  return {
    state: "unavailable",
    message,
  };
}

function webSearchStartupMessage(status: WebSearchStatus | null): string {
  switch (status?.state) {
    case "needs_install":
    case "installing":
      return "Preparing web search…";
    default:
      return "Starting web search…";
  }
}

function generationStatusForWebSearchLifecycle(
  state: WebSearchState,
): string | null {
  switch (state) {
    case "needs_install":
    case "installing":
      return "Preparing web search…";
    case "stopped":
    case "starting":
      return "Starting web search…";
    case "ready":
      return "Friday is thinking…";
    default:
      return null;
  }
}

function generationStatusForToolCall(name: string): string {
  switch (name) {
    case "get_current_datetime":
      return "Checking the date and time…";
    case "web_search":
      return "Searching the web…";
    case "web_fetch":
      return "Reading the page…";
    case "file_read":
      return "Reading local files…";
    case "list_directory":
      return "Inspecting local files…";
    case "calculate":
      return "Calculating…";
    default:
      return "Working…";
  }
}

function generationStatusForToolResult(name: string): string | null {
  switch (name) {
    case "web_search":
    case "web_fetch":
    case "get_current_datetime":
    case "file_read":
    case "list_directory":
    case "calculate":
      return "Friday is thinking…";
    default:
      return null;
  }
}

function settingsToInput(settings: AppSettings): AppSettingsInput {
  return {
    auto_start_backend: settings.auto_start_backend,
    auto_download_updates: settings.auto_download_updates,
    user_display_name: settings.user_display_name,
    theme_mode: settings.theme_mode,
    chat: {
      reply_language: settings.chat.reply_language,
      max_tokens: settings.chat.max_tokens,
      web_assist_enabled: settings.chat.web_assist_enabled,
      knowledge_enabled: settings.chat.knowledge_enabled,
      generation: {
        temperature: settings.chat.generation.temperature,
        top_p: settings.chat.generation.top_p,
        thinking_enabled: settings.chat.generation.thinking_enabled,
      },
    },
  };
}

function resolveQueuedSettingValue<T>(
  committed: T,
  desired: T,
  requested: T,
): T {
  return Object.is(requested, committed) && !Object.is(desired, committed)
    ? desired
    : requested;
}

function mergeQueuedSettingsInput(
  committed: AppSettingsInput,
  desired: AppSettingsInput,
  requested: AppSettingsInput,
): AppSettingsInput {
  return {
    auto_start_backend: resolveQueuedSettingValue(
      committed.auto_start_backend,
      desired.auto_start_backend,
      requested.auto_start_backend,
    ),
    auto_download_updates: resolveQueuedSettingValue(
      committed.auto_download_updates,
      desired.auto_download_updates,
      requested.auto_download_updates,
    ),
    user_display_name: resolveQueuedSettingValue(
      committed.user_display_name,
      desired.user_display_name,
      requested.user_display_name,
    ),
    theme_mode: resolveQueuedSettingValue(
      committed.theme_mode,
      desired.theme_mode,
      requested.theme_mode,
    ),
    chat: {
      reply_language: resolveQueuedSettingValue(
        committed.chat.reply_language,
        desired.chat.reply_language,
        requested.chat.reply_language,
      ),
      max_tokens: resolveQueuedSettingValue(
        committed.chat.max_tokens,
        desired.chat.max_tokens,
        requested.chat.max_tokens,
      ),
      web_assist_enabled: resolveQueuedSettingValue(
        committed.chat.web_assist_enabled,
        desired.chat.web_assist_enabled,
        requested.chat.web_assist_enabled,
      ),
      knowledge_enabled: resolveQueuedSettingValue(
        committed.chat.knowledge_enabled,
        desired.chat.knowledge_enabled,
        requested.chat.knowledge_enabled,
      ),
      generation: {
        temperature: resolveQueuedSettingValue(
          committed.chat.generation.temperature,
          desired.chat.generation.temperature,
          requested.chat.generation.temperature,
        ),
        top_p: resolveQueuedSettingValue(
          committed.chat.generation.top_p,
          desired.chat.generation.top_p,
          requested.chat.generation.top_p,
        ),
        thinking_enabled: resolveQueuedSettingValue(
          committed.chat.generation.thinking_enabled,
          desired.chat.generation.thinking_enabled,
          requested.chat.generation.thinking_enabled,
        ),
      },
    },
  };
}

function settingsInputsEqual(
  left: AppSettingsInput | null,
  right: AppSettingsInput | null,
): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function canUseWebSearch(
  backendStatus: BackendStatus | null,
  webSearchStatus: WebSearchStatus | null,
) {
  return Boolean(
    backendStatus?.supports_native_tools &&
    webSearchStatus?.available &&
    webSearchStatus.state !== "unavailable" &&
    webSearchStatus.state !== "config_error" &&
    webSearchStatus.state !== "port_conflict",
  );
}

function canUseKnowledge(status: KnowledgeStatus | null) {
  return Boolean(
    status && status.state !== "unavailable" && status.state !== "error",
  );
}

function planSettingsRefresh(
  previous: AppSettingsInput,
  next: AppSettingsInput,
) {
  return {
    backend: previous.chat.max_tokens !== next.chat.max_tokens,
    webSearch:
      previous.chat.web_assist_enabled !== next.chat.web_assist_enabled,
    knowledge: previous.chat.knowledge_enabled !== next.chat.knowledge_enabled,
  };
}

function upsertIngestProgress(
  current: KnowledgeIngestProgress[],
  next: KnowledgeIngestProgress,
) {
  const key = next.sourceId ?? next.locator;
  const remaining = current.filter(
    (entry) => (entry.sourceId ?? entry.locator) !== key,
  );
  return [next, ...remaining].slice(0, 12);
}

function notifyError(title: string, error: unknown) {
  notification.error({
    message: title,
    description: toErrorMessage(error),
  });
}

function notifyWarning(title: string, error: unknown) {
  notification.warning({
    message: title,
    description: toErrorMessage(error),
  });
}

function serializeAttachments(attachments: FileAttachment[]) {
  return attachments.map((attachment) => ({
    path: attachment.path,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    content: attachment.content
      ? attachment.content.text
        ? { text: attachment.content.text }
        : attachment.content.dataUrl
          ? { dataUrl: attachment.content.dataUrl }
          : attachment.content.path
            ? { path: attachment.content.path }
            : null
      : null,
  }));
}

export function useAppController() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [persistedMessages, setPersistedMessages] = useState<Message[]>([]);
  const [fallbackMessages, setFallbackMessages] = useState<FridayUIMessage[]>(
    [],
  );
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(
    null,
  );
  const [webSearchStatus, setWebSearchStatus] =
    useState<WebSearchStatus | null>(null);
  const [knowledgeStatus, setKnowledgeStatus] =
    useState<KnowledgeStatus | null>(null);
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSource[]>(
    [],
  );
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStats | null>(
    null,
  );
  const [knowledgeIngestProgress, setKnowledgeIngestProgress] = useState<
    KnowledgeIngestProgress[]
  >([]);
  const [serviceDiagnostics, setServiceDiagnostics] =
    useState<ServiceDiagnosticsBundle | null>(null);
  const [currentModel, setCurrentModel] = useState("—");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [activeModelId, setActiveModelId] = useState<string>("");
  const [isSwitchingModel, setIsSwitchingModel] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [availableAppUpdate, setAvailableAppUpdate] =
    useState<AppUpdateInfo | null>(null);
  const [installedAppUpdateVersion, setInstalledAppUpdateVersion] = useState<
    string | null
  >(null);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const [isInstallingAppUpdate, setIsInstallingAppUpdate] = useState(false);

  const activeSessionRef = useRef<Session | null>(null);
  const activeRequestSessionIdRef = useRef<string | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const lastChatErrorRef = useRef<string | null>(null);
  const requestFailedRef = useRef(false);
  const settingsSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSettingsSaveCountRef = useRef(0);
  const committedSettingsRef = useRef<AppSettingsInput | null>(null);
  const desiredSettingsRef = useRef<AppSettingsInput | null>(null);
  const autoInstallAttemptedVersionRef = useRef<string | null>(null);

  const transport = useMemo(() => new TauriChatTransport(), []);
  const initialChatMessages = useMemo(
    () => toFridayChatMessages(persistedMessages),
    [persistedMessages],
  );

  const {
    messages: chatMessages,
    setMessages: setChatMessages,
    sendMessage: sendChatMessage,
    stop: stopChat,
    status: chatStatus,
    error: chatError,
    clearError: clearChatError,
  } = useChat<FridayChatMessage>({
    id: activeSession?.id ?? "bootstrap-chat",
    messages: initialChatMessages,
    transport,
    experimental_throttle: 16,
    onError: (error) => {
      lastChatErrorRef.current = toErrorMessage(error);
      requestFailedRef.current = true;
      setGenerationStatus(null);
    },
    onFinish: ({ message }) => {
      activeRequestSessionIdRef.current = null;
      activeRequestIdRef.current = null;
      setGenerationStatus(null);
      if (message.metadata?.modelUsed) {
        setCurrentModel(formatModelLabel(message.metadata.modelUsed));
      }
    },
  });

  const messages = useMemo(
    () => normalizeFridayMessages(chatMessages),
    [chatMessages],
  );
  const isGenerating = chatStatus === "submitted" || chatStatus === "streaming";

  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  useEffect(() => {
    if (!activeSession) {
      if (chatMessages.length > 0) {
        setChatMessages([]);
      }
      if (chatError) {
        clearChatError();
      }
      return;
    }

    if (chatStatus === "submitted" || chatStatus === "streaming") {
      return;
    }

    setChatMessages(initialChatMessages);
    if (chatError) {
      clearChatError();
    }
  }, [
    activeSession,
    chatError,
    chatMessages.length,
    chatStatus,
    clearChatError,
    initialChatMessages,
    setChatMessages,
  ]);

  const applySavedSettingsState = (nextSettings: AppSettings) => {
    setSettings(nextSettings);
    setWebSearchEnabled(nextSettings.chat.web_assist_enabled);
    setKnowledgeEnabled(nextSettings.chat.knowledge_enabled);
    setThinkingEnabled(Boolean(nextSettings.chat.generation.thinking_enabled));
  };

  const appendAssistantError = useCallback(
    (sessionId: string, message: string) => {
      setChatMessages((previous) => [
        ...previous,
        makeFridayAssistantMessage({
          id: makeId(),
          sessionId,
          content: `⚠️ ${message}`,
        }),
      ]);
      clearChatError();
    },
    [clearChatError, setChatMessages],
  );

  useEffect(() => {
    if (!chatError || !requestFailedRef.current) {
      return;
    }

    const sessionId =
      activeRequestSessionIdRef.current ?? activeSessionRef.current?.id;
    const errorMessage = lastChatErrorRef.current ?? toErrorMessage(chatError);

    if (sessionId) {
      appendAssistantError(sessionId, errorMessage);
    }

    activeRequestSessionIdRef.current = null;
    activeRequestIdRef.current = null;
    lastChatErrorRef.current = null;
  }, [appendAssistantError, chatError]);

  const resetGenerationUiState = () => {
    activeRequestSessionIdRef.current = null;
    activeRequestIdRef.current = null;
    lastChatErrorRef.current = null;
    setGenerationStatus(null);
    clearChatError();
  };

  const matchesActiveRequest = useCallback(
    (payload: { sessionId?: string | null; requestId?: string | null }) => {
      const activeSessionId = activeRequestSessionIdRef.current;
      if (!activeSessionId) {
        return false;
      }

      if (activeRequestIdRef.current) {
        return payload.requestId === activeRequestIdRef.current;
      }

      if (payload.sessionId !== activeSessionId) {
        return false;
      }

      if (typeof payload.requestId === "string" && payload.requestId) {
        activeRequestIdRef.current = payload.requestId;
      }

      return true;
    },
    [],
  );

  const refreshModelInventory = async () => {
    const [modelsResponse, activeModel, downloadedIdsResponse] =
      await Promise.all([
        invoke<ModelInfo[]>("list_models"),
        invoke<ModelInfo>("get_active_model"),
        invoke<string[]>("list_downloaded_model_ids"),
      ]);

    const models = Array.isArray(modelsResponse) ? modelsResponse : [];
    const downloadedIds = Array.isArray(downloadedIdsResponse)
      ? downloadedIdsResponse
      : [];

    setAvailableModels(models);
    setActiveModelId(activeModel?.id ?? "");
    setDownloadedModelIds(downloadedIds);
    if (activeModel?.display_name) {
      setCurrentModel(activeModel.display_name);
    }

    return { models, activeModel, downloadedIds };
  };

  const detectBackendStatus = async () => {
    const status = await invoke<BackendStatus>("detect_backend");
    setBackendStatus(status);
    if (status.models[0]) {
      setCurrentModel(formatModelLabel(status.models[0]));
    }
    return status;
  };

  const detectWebSearchStatus = async () => {
    try {
      const status =
        (await invoke<WebSearchStatus>("get_web_search_status")) ??
        unavailableWebSearchStatus();
      setWebSearchStatus(status);
      return status;
    } catch (error) {
      const status = unavailableWebSearchStatus(toErrorMessage(error));
      setWebSearchStatus(status);
      return status;
    }
  };

  const detectKnowledgeStatus = async () => {
    try {
      const status =
        (await invoke<KnowledgeStatus>("get_knowledge_status")) ??
        unavailableKnowledgeStatus();
      setKnowledgeStatus(status);
      return status;
    } catch (error) {
      const status = unavailableKnowledgeStatus(toErrorMessage(error));
      setKnowledgeStatus(status);
      return status;
    }
  };

  const refreshKnowledge = async ({
    includeStatus = true,
  }: {
    includeStatus?: boolean;
  } = {}) => {
    const [statusResult, sourcesResult, statsResult] = await Promise.allSettled(
      [
        includeStatus
          ? detectKnowledgeStatus()
          : Promise.resolve(knowledgeStatus),
        invoke<KnowledgeSource[]>("knowledge_list_sources"),
        invoke<KnowledgeStats>("knowledge_stats"),
      ],
    );

    if (statusResult.status === "fulfilled" && statusResult.value) {
      setKnowledgeStatus(statusResult.value);
    } else if (includeStatus) {
      setKnowledgeStatus(
        unavailableKnowledgeStatus(
          statusResult.status === "rejected"
            ? toErrorMessage(statusResult.reason)
            : undefined,
        ),
      );
    }

    if (
      sourcesResult.status === "fulfilled" &&
      Array.isArray(sourcesResult.value)
    ) {
      setKnowledgeSources(sourcesResult.value);
    } else if (sourcesResult.status === "rejected") {
      setKnowledgeSources([]);
    }

    if (
      statsResult.status === "fulfilled" &&
      statsResult.value &&
      typeof statsResult.value === "object"
    ) {
      setKnowledgeStats(statsResult.value);
    } else if (statsResult.status === "rejected") {
      setKnowledgeStats(null);
    }
  };

  const warmBackendIfNeeded = async (
    statusValue: BackendStatus | null | undefined,
  ) => {
    if (
      !statusValue ||
      statusValue.connected ||
      statusValue.state !== "ready"
    ) {
      return statusValue;
    }

    try {
      const warmed = await invoke<BackendStatus>("warm_backend");
      setBackendStatus(warmed);
      if (warmed.models[0]) {
        setCurrentModel(formatModelLabel(warmed.models[0]));
      }
      return warmed;
    } catch {
      return statusValue;
    }
  };

  const refreshBackendStatus = async ({
    includeModelInventory = true,
  }: {
    includeModelInventory?: boolean;
  } = {}) => {
    if (!includeModelInventory) {
      const [status] = await Promise.all([
        detectBackendStatus(),
        detectWebSearchStatus(),
      ]);
      return (await warmBackendIfNeeded(status)) ?? status;
    }

    const [status] = await Promise.all([
      detectBackendStatus(),
      detectWebSearchStatus(),
      refreshModelInventory(),
    ]);
    return (await warmBackendIfNeeded(status)) ?? status;
  };

  const checkForAppUpdate = async () => {
    try {
      const update =
        (await invoke<AppUpdateInfo | null>("check_for_app_update")) ?? null;
      setAvailableAppUpdate(update);
      setAppUpdateError(null);
      return update;
    } catch (error) {
      const message = toErrorMessage(error);
      if (message === "Auto-update signing key is not configured.") {
        setAvailableAppUpdate(null);
        setAppUpdateError(null);
        return null;
      }
      console.warn("check_for_app_update failed:", error);
      setAvailableAppUpdate(null);
      setAppUpdateError(message);
      return null;
    }
  };

  const installAppUpdate = useCallback(async () => {
    if (isInstallingAppUpdate) {
      return;
    }

    setIsInstallingAppUpdate(true);
    setAppUpdateError(null);
    try {
      const result = await invoke<AppUpdateInstallResult>("install_app_update");
      if (result.installed) {
        setInstalledAppUpdateVersion(result.version);
        setAvailableAppUpdate(null);
      }
      return result;
    } catch (error) {
      const message = toErrorMessage(error);
      setAppUpdateError(message);
      throw error;
    } finally {
      setIsInstallingAppUpdate(false);
    }
  }, [isInstallingAppUpdate]);

  const restartApp = async () => {
    await invoke("restart_app");
  };

  const dismissAppUpdate = () => {
    setAvailableAppUpdate(null);
  };

  const clearAppUpdateError = () => {
    setAppUpdateError(null);
  };

  const clearInstalledAppUpdateVersion = () => {
    setInstalledAppUpdateVersion(null);
  };

  useEffect(() => {
    if (!settings?.auto_download_updates) {
      autoInstallAttemptedVersionRef.current = null;
      return;
    }

    if (
      !availableAppUpdate ||
      isInstallingAppUpdate ||
      installedAppUpdateVersion === availableAppUpdate.version ||
      autoInstallAttemptedVersionRef.current === availableAppUpdate.version
    ) {
      return;
    }

    autoInstallAttemptedVersionRef.current = availableAppUpdate.version;
    void installAppUpdate().catch(() => undefined);
  }, [
    availableAppUpdate,
    installAppUpdate,
    installedAppUpdateVersion,
    isInstallingAppUpdate,
    settings?.auto_download_updates,
  ]);

  const bootstrap = async () => {
    setIsBootstrapping(true);
    setBootstrapError(null);
    try {
      const payload = await invoke<BootstrapPayload>("bootstrap_app");
      const normalizedSettings = settingsToInput(payload.settings);
      committedSettingsRef.current = normalizedSettings;
      desiredSettingsRef.current = normalizedSettings;
      setSessions(payload.sessions);
      setActiveSession(payload.currentSession);
      setPersistedMessages(payload.messages);
      setFallbackMessages([]);
      applySavedSettingsState(payload.settings);
      setBackendStatus(payload.backendStatus);
      setWebSearchStatus(
        payload.webSearchStatus ?? unavailableWebSearchStatus(),
      );
      setKnowledgeStatus(
        payload.knowledgeStatus ?? unavailableKnowledgeStatus(),
      );
      setKnowledgeStats(payload.knowledgeStats ?? null);
      setKnowledgeSources(payload.knowledgeSources ?? []);
      setAvailableModels(payload.availableModels ?? []);
      setDownloadedModelIds(payload.downloadedModelIds ?? []);
      setActiveModelId(payload.activeModel?.id ?? "");
      setServiceDiagnostics(payload.serviceDiagnostics ?? null);
      setKnowledgeIngestProgress([]);

      // Keep startup resilient offline: update check runs in the background and
      // must not delay chat readiness.
      void checkForAppUpdate();

      void warmBackendIfNeeded(payload.backendStatus);
      if (payload.activeModel?.display_name) {
        setCurrentModel(payload.activeModel.display_name);
      } else if (
        payload.backendStatus.connected &&
        payload.backendStatus.models[0] &&
        !payload.backendStatus.models[0].includes("undefined")
      ) {
        setCurrentModel(formatModelLabel(payload.backendStatus.models[0]));
      }
    } finally {
      setIsBootstrapping(false);
    }
  };

  const refreshSessionState = async (sessionId: string) => {
    const [selection, nextSessions] = await Promise.all([
      invoke<SessionSelectionResult>("select_session", { sessionId }),
      invoke<Session[]>("list_sessions"),
    ]);

    if (activeSessionRef.current?.id === sessionId) {
      setActiveSession(selection.session);
      setPersistedMessages(selection.messages);
    }
    setSessions(nextSessions);
    resetGenerationUiState();
  };

  useEffect(() => {
    const registerListeners = async () => {
      const unlistenActivity = await listen<{ model?: string }>(
        "activity",
        (event) => {
          if (event.payload.model) {
            setCurrentModel(formatModelLabel(event.payload.model));
          }
        },
      );

      const unlistenWebSearchStatus = await listen<WebSearchStatus>(
        "web-search-status",
        (event) => {
          setWebSearchStatus(event.payload);
          setServiceDiagnostics((previous) =>
            previous
              ? {
                  ...previous,
                  searxng: {
                    ...previous.searxng,
                    message: event.payload.message,
                  },
                }
              : previous,
          );
          if (!activeRequestSessionIdRef.current) {
            return;
          }

          const nextStatus = generationStatusForWebSearchLifecycle(
            event.payload.state,
          );
          if (nextStatus) {
            setGenerationStatus(nextStatus);
          }
        },
      );

      const unlistenKnowledgeStatus = await listen<KnowledgeStatus>(
        "knowledge-status",
        (event) => {
          setKnowledgeStatus(event.payload);
          setServiceDiagnostics((previous) =>
            previous
              ? {
                  ...previous,
                  knowledge: {
                    ...previous.knowledge,
                    message: event.payload.message,
                  },
                }
              : previous,
          );
        },
      );

      const unlistenKnowledgeIngestProgress =
        await listen<KnowledgeIngestProgress>(
          "knowledge-ingest-progress",
          (event) => {
            setKnowledgeIngestProgress((previous) =>
              upsertIngestProgress(previous, event.payload),
            );
          },
        );

      const unlistenToolCall = await listen<ToolCallEvent>(
        "tool-call-start",
        (event) => {
          if (!matchesActiveRequest(event.payload)) {
            return;
          }

          setGenerationStatus(generationStatusForToolCall(event.payload.name));
        },
      );

      const unlistenToolResult = await listen<ToolResultEvent>(
        "tool-call-result",
        (event) => {
          if (!matchesActiveRequest(event.payload)) {
            return;
          }

          const nextStatus = generationStatusForToolResult(event.payload.name);
          if (nextStatus) {
            setGenerationStatus(nextStatus);
          }
        },
      );

      return () => {
        unlistenActivity();
        unlistenWebSearchStatus();
        unlistenKnowledgeStatus();
        unlistenKnowledgeIngestProgress();
        unlistenToolCall();
        unlistenToolResult();
      };
    };

    let cancelled = false;
    let dispose: (() => void) | undefined;
    registerListeners()
      .then((cleanup) => {
        if (cancelled) {
          cleanup();
          return;
        }
        dispose = cleanup;
      })
      .catch(() => undefined);

    void bootstrap().catch((error) => {
      const message = toErrorMessage(error);
      setBootstrapError(message);
      setFallbackMessages([
        normalizeFridayMessage(
          makeFridayAssistantMessage({
            id: `bootstrap-${makeId()}`,
            sessionId: "bootstrap",
            content: `⚠️ ${message}`,
          }),
        ),
      ]);
      setIsBootstrapping(false);
    });

    return () => {
      cancelled = true;
      activeRequestSessionIdRef.current = null;
      activeRequestIdRef.current = null;
      dispose?.();
    };
  }, [matchesActiveRequest]);

  const createSession = async () => {
    if (isGenerating || activeRequestSessionIdRef.current) return;

    const session = await invoke<Session>("create_session", {
      title: "New chat",
    });
    setSessions((previous) => [
      session,
      ...previous.filter((item) => item.id !== session.id),
    ]);
    setActiveSession(session);
    setPersistedMessages([]);
    setFallbackMessages([]);
    resetGenerationUiState();
  };

  const selectSession = async (sessionId: string) => {
    if (isGenerating || activeRequestSessionIdRef.current) return;

    const result = await invoke<SessionSelectionResult>("select_session", {
      sessionId,
    });
    setActiveSession(result.session);
    setPersistedMessages(result.messages);
    resetGenerationUiState();
  };

  const deleteSession = async (sessionId: string) => {
    if (isGenerating || activeRequestSessionIdRef.current) return;

    await invoke("delete_session", { sessionId });
    const deletedActiveSession = activeSessionRef.current?.id === sessionId;
    const nextSessions = await invoke<Session[]>("list_sessions");
    setSessions(nextSessions);
    resetGenerationUiState();

    if (
      !deletedActiveSession &&
      activeSessionRef.current?.id &&
      nextSessions.some(
        (session) => session.id === activeSessionRef.current?.id,
      )
    ) {
      return;
    }

    const fallbackSession = nextSessions[0] ?? null;
    if (!fallbackSession) {
      setActiveSession(null);
      setPersistedMessages([]);
      setChatMessages([]);
      return;
    }

    const selection = await invoke<SessionSelectionResult>("select_session", {
      sessionId: fallbackSession.id,
    });
    setActiveSession(selection.session);
    setPersistedMessages(selection.messages);
  };

  const sendMessage = async (
    content: string,
    attachments?: FileAttachment[],
  ) => {
    const trimmed = content.trim();
    const readyAttachments =
      attachments?.filter((attachment) => attachment.status === "ready") ?? [];
    const hasAttachments = readyAttachments.length > 0;
    if ((!trimmed && !hasAttachments) || isGenerating || !activeSession) return;

    const sessionId = activeSession.id;
    const effectiveThinkingEnabled =
      thinkingEnabled && (backendStatus?.supports_thinking ?? false);
    const effectiveWebAssistEnabled =
      webSearchEnabled && canUseWebSearch(backendStatus, webSearchStatus);
    const effectiveKnowledgeEnabled =
      knowledgeEnabled && canUseKnowledge(knowledgeStatus);
    const serializedAttachments = hasAttachments
      ? serializeAttachments(readyAttachments)
      : null;
    const attachmentsSummary = readyAttachments.map(
      (attachment) => attachment.name,
    );

    lastChatErrorRef.current = null;
    activeRequestSessionIdRef.current = sessionId;
    activeRequestIdRef.current = null;

    const needsWebSearchStartup =
      effectiveWebAssistEnabled && webSearchStatus?.state !== "ready";
    setGenerationStatus(
      needsWebSearchStartup
        ? webSearchStartupMessage(webSearchStatus)
        : backendStatus?.connected
          ? "Friday is thinking…"
          : "Starting local model…",
    );

    try {
      await sendChatMessage(
        {
          text: trimmed,
          metadata: {
            sessionId,
            createdAt: new Date().toISOString(),
            ...(attachmentsSummary.length > 0 ? { attachmentsSummary } : {}),
          },
        },
        {
          body: {
            attachments: serializedAttachments,
            thinkingEnabled: effectiveThinkingEnabled,
            webAssistEnabled: effectiveWebAssistEnabled,
            knowledgeEnabled: effectiveKnowledgeEnabled,
          },
        },
      );
      await Promise.resolve();

      if (requestFailedRef.current) {
        requestFailedRef.current = false;
        lastChatErrorRef.current = null;
        return;
      }

      if (activeSessionRef.current?.id === sessionId) {
        await refreshSessionState(sessionId);
      }
    } catch (error) {
      activeRequestSessionIdRef.current = null;
      setGenerationStatus(null);

      if (activeSessionRef.current?.id === sessionId) {
        appendAssistantError(sessionId, toErrorMessage(error));
      }
    }
  };

  const cancelGeneration = async () => {
    setGenerationStatus("Stopping…");
    stopChat();
    try {
      const response =
        await invoke<CancelGenerationResponse>("cancel_generation");
      if (response.status === "failed") {
        const message =
          response.message ??
          "Could not stop the current response. Please try again.";
        notifyError("Cancellation failed", message);
        setGenerationStatus(message);
        return;
      }

      if (response.status === "not_running") {
        activeRequestSessionIdRef.current = null;
        setGenerationStatus(null);
      }
    } catch (error) {
      notifyError("Failed to cancel the current response", error);
      setGenerationStatus(null);
    }
  };

  const saveAppSettings = (input: AppSettingsInput) => {
    const committedSettings =
      committedSettingsRef.current ??
      desiredSettingsRef.current ??
      (settings ? settingsToInput(settings) : input);
    const desiredSettings = desiredSettingsRef.current ?? committedSettings;
    const mergedInput = mergeQueuedSettingsInput(
      committedSettings,
      desiredSettings,
      input,
    );

    desiredSettingsRef.current = mergedInput;
    pendingSettingsSaveCountRef.current += 1;
    setIsSavingSettings(true);

    const saveTask = settingsSaveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const saved = await invoke<AppSettings>("save_settings", {
          input: mergedInput,
        });
        const savedInput = settingsToInput(saved);
        const refreshPlan = planSettingsRefresh(committedSettings, savedInput);
        committedSettingsRef.current = savedInput;
        if (settingsInputsEqual(desiredSettingsRef.current, mergedInput)) {
          desiredSettingsRef.current = savedInput;
          applySavedSettingsState(saved);
        }

        const refreshTasks: Array<Promise<unknown>> = [];
        if (refreshPlan.backend) {
          refreshTasks.push(detectBackendStatus());
        }
        if (refreshPlan.webSearch) {
          refreshTasks.push(detectWebSearchStatus());
        }
        if (refreshPlan.knowledge) {
          refreshTasks.push(detectKnowledgeStatus());
        }
        if (refreshTasks.length > 0) {
          const refreshResults = await Promise.allSettled(refreshTasks);
          refreshResults.forEach((result) => {
            if (result.status === "rejected") {
              notifyWarning(
                "Settings saved, but status refresh failed",
                result.reason,
              );
            }
          });
        }

        return saved;
      });

    settingsSaveChainRef.current = saveTask.then(
      () => undefined,
      () => undefined,
    );

    return saveTask.finally(() => {
      pendingSettingsSaveCountRef.current -= 1;
      if (pendingSettingsSaveCountRef.current <= 0) {
        pendingSettingsSaveCountRef.current = 0;
        setIsSavingSettings(false);
      }
    });
  };

  const setReplyLanguage = async (lang: ReplyLanguage) => {
    if (!settings || settings.chat.reply_language === lang) return;
    try {
      await saveAppSettings({
        auto_start_backend: settings.auto_start_backend,
        auto_download_updates: settings.auto_download_updates,
        user_display_name: settings.user_display_name,
        theme_mode: settings.theme_mode,
        chat: {
          reply_language: lang,
          max_tokens: settings.chat.max_tokens,
          web_assist_enabled: settings.chat.web_assist_enabled,
          knowledge_enabled: settings.chat.knowledge_enabled,
          generation: settings.chat.generation,
        },
      });
    } catch (err) {
      notifyError("Language switch failed", err);
    }
  };

  const toggleWebSearch = async () => {
    if (!canUseWebSearch(backendStatus, webSearchStatus) || !settings) {
      return;
    }
    const next = !webSearchEnabled;
    setWebSearchEnabled(next);
    try {
      await saveAppSettings({
        auto_start_backend: settings.auto_start_backend,
        auto_download_updates: settings.auto_download_updates,
        user_display_name: settings.user_display_name,
        theme_mode: settings.theme_mode,
        chat: {
          reply_language: settings.chat.reply_language,
          max_tokens: settings.chat.max_tokens,
          web_assist_enabled: next,
          knowledge_enabled: settings.chat.knowledge_enabled,
          generation: settings.chat.generation,
        },
      });
    } catch {
      setWebSearchEnabled(!next);
    }
  };

  const toggleThinking = async () => {
    if (!settings) {
      return;
    }

    const next = !thinkingEnabled;
    setThinkingEnabled(next);
    try {
      await saveAppSettings({
        auto_start_backend: settings.auto_start_backend,
        auto_download_updates: settings.auto_download_updates,
        user_display_name: settings.user_display_name,
        theme_mode: settings.theme_mode,
        chat: {
          reply_language: settings.chat.reply_language,
          max_tokens: settings.chat.max_tokens,
          web_assist_enabled: settings.chat.web_assist_enabled,
          knowledge_enabled: settings.chat.knowledge_enabled,
          generation: {
            ...settings.chat.generation,
            thinking_enabled: next,
          },
        },
      });
    } catch {
      setThinkingEnabled(!next);
    }
  };

  const toggleKnowledge = async () => {
    if (!settings || !canUseKnowledge(knowledgeStatus)) {
      return;
    }

    const next = !knowledgeEnabled;
    setKnowledgeEnabled(next);
    try {
      await saveAppSettings({
        auto_start_backend: settings.auto_start_backend,
        auto_download_updates: settings.auto_download_updates,
        user_display_name: settings.user_display_name,
        theme_mode: settings.theme_mode,
        chat: {
          reply_language: settings.chat.reply_language,
          max_tokens: settings.chat.max_tokens,
          web_assist_enabled: settings.chat.web_assist_enabled,
          knowledge_enabled: next,
          generation: settings.chat.generation,
        },
      });
    } catch {
      setKnowledgeEnabled(!next);
    }
  };

  const ingestKnowledgeFile = async (filePath: string) => {
    await invoke("knowledge_ingest_file", { filePath });
    await refreshKnowledge();
  };

  const ingestKnowledgeUrl = async (url: string) => {
    await invoke("knowledge_ingest_url", { url });
    await refreshKnowledge();
  };

  const deleteKnowledgeSource = async (sourceId: string) => {
    await invoke("knowledge_delete_source", { sourceId });
    await refreshKnowledge();
  };

  const selectModel = async (modelId: string) => {
    if (modelId === activeModelId || isGenerating) {
      return;
    }

    setIsSwitchingModel(true);
    try {
      const selected = await invoke<ModelInfo>("select_model", { modelId });
      setActiveModelId(selected.id);
      setCurrentModel(selected.display_name);
      await refreshBackendStatus();
    } finally {
      setIsSwitchingModel(false);
    }
  };

  const configurableModels = availableModels.filter((model) =>
    downloadedModelIds.includes(model.id),
  );
  const webSearchToggleAvailable = canUseWebSearch(
    backendStatus,
    webSearchStatus,
  );
  const knowledgeToggleAvailable = canUseKnowledge(knowledgeStatus);
  const renderedMessages = activeSession ? messages : fallbackMessages;

  return {
    sessions,
    activeSession,
    messages: renderedMessages,
    settings,
    backendStatus,
    webSearchStatus,
    knowledgeStatus,
    knowledgeSources,
    knowledgeStats,
    knowledgeIngestProgress,
    serviceDiagnostics,
    currentModel,
    activeModelId,
    configurableModels,
    isBootstrapping,
    bootstrapError,
    isGenerating,
    isSavingSettings,
    isSwitchingModel,
    createSession,
    selectSession,
    deleteSession,
    sendMessage,
    cancelGeneration,
    refreshBackendStatus,
    refreshKnowledge,
    refreshModelInventory,
    saveAppSettings,
    setReplyLanguage,
    selectModel,
    webSearchEnabled,
    knowledgeEnabled,
    thinkingEnabled,
    generationStatus,
    availableAppUpdate,
    installedAppUpdateVersion,
    appUpdateError,
    isInstallingAppUpdate,
    nativeToolSupportAvailable: backendStatus?.supports_native_tools ?? false,
    webSearchToggleAvailable,
    knowledgeToggleAvailable,
    audioInputAvailable: backendStatus?.supports_audio_input ?? false,
    thinkingAvailable: backendStatus?.supports_thinking ?? false,
    toggleWebSearch,
    toggleKnowledge,
    toggleThinking,
    ingestKnowledgeFile,
    ingestKnowledgeUrl,
    deleteKnowledgeSource,
    installAppUpdate,
    restartApp,
    dismissAppUpdate,
    clearAppUpdateError,
    clearInstalledAppUpdateVersion,
  };
}
