import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppSettings,
  AppSettingsInput,
  BackendStatus,
  BootstrapPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatTokenPayload,
  FileAttachment,
  KnowledgeSource,
  KnowledgeStats,
  KnowledgeStatus,
  Message,
  ModelInfo,
  ReplyLanguage,
  Session,
  SessionSelectionResult,
  ToolCallEvent,
  ToolResultEvent,
  WebSearchState,
  WebSearchStatus,
} from "../types";

const TOKEN_FLUSH_INTERVAL_MS = 16;

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
  message = "Local web search is unavailable.",
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
      return "Preparing local web search…";
    default:
      return "Starting local web search…";
  }
}

function generationStatusForWebSearchLifecycle(
  state: WebSearchState,
): string | null {
  switch (state) {
    case "needs_install":
    case "installing":
      return "Preparing local web search…";
    case "stopped":
    case "starting":
      return "Starting local web search…";
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

function normalizeChatErrorPayload(
  payload: string | ChatErrorPayload,
): ChatErrorPayload {
  if (typeof payload === "string") {
    return { message: payload };
  }
  return payload;
}

function hasOwnPayloadField<K extends string>(
  payload: object,
  key: K,
): payload is Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function makeAssistantMessage(sessionId: string, content: string): Message {
  return {
    id: makeId(),
    session_id: sessionId,
    role: "assistant",
    content,
    created_at: new Date().toISOString(),
  };
}

function getAssistantThinking(contentParts: unknown): string {
  if (!contentParts || typeof contentParts !== "object") {
    return "";
  }

  const thinking = (contentParts as { thinking?: unknown }).thinking;
  return typeof thinking === "string" ? thinking : "";
}

function welcomeMessageForLanguage(
  replyLanguage: ReplyLanguage = "english",
  userDisplayName = "",
) {
  const name = userDisplayName.trim();
  switch (replyLanguage) {
    case "hindi":
      if (name) {
        return `नमस्ते, ${name}! मैं **Friday** हूं, आपकी निजी AI सहायक.\n\nमैं आपके डिवाइस पर ही चलती हूं। मैं हिंदी में जवाब दूंगी।`;
      }
      return "नमस्ते! मैं **Friday** हूं, आपकी निजी AI सहायक.\n\nमैं आपके डिवाइस पर ही चलती हूं। मैं हिंदी में जवाब दूंगी।";
    case "bengali":
      if (name) {
        return `নমস্কার, ${name}! আমি **Friday**, আপনার ব্যক্তিগত AI সহায়ক.\n\nআমি আপনার ডিভাইসেই চলি। আমি বাংলায় উত্তর দেব।`;
      }
      return "নমস্কার! আমি **Friday**, আপনার ব্যক্তিগত AI সহায়ক.\n\nআমি আপনার ডিভাইসেই চলি। আমি বাংলায় উত্তর দেব।";
    case "marathi":
      if (name) {
        return `नमस्कार, ${name}! मी **Friday**, तुमची वैयक्तिक AI सहाय्यक आहे.\n\nमी तुमच्या डिव्हाइसवरच चालते. मी मराठीत उत्तर देईन।`;
      }
      return "नमस्कार! मी **Friday**, तुमची वैयक्तिक AI सहाय्यक आहे.\n\nमी तुमच्या डिव्हाइसवरच चालते. मी मराठीत उत्तर देईन।";
    case "tamil":
      if (name) {
        return `வணக்கம், ${name}! நான் **Friday**, உங்கள் தனிப்பட்ட AI உதவியாளர்.\n\nநான் உங்கள் சாதனத்திலேயே இயங்குகிறேன். நான் தமிழில் பதிலளிப்பேன்.`;
      }
      return "வணக்கம்! நான் **Friday**, உங்கள் தனிப்பட்ட AI உதவியாளர்.\n\nநான் உங்கள் சாதனத்திலேயே இயங்குகிறேன். நான் தமிழில் பதிலளிப்பேன்.";
    case "punjabi":
      if (name) {
        return `ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ${name}! ਮੈਂ **Friday**, ਤੁਹਾਡੀ ਨਿੱਜੀ AI ਸਹਾਇਕ ਹਾਂ.\n\nਮੈਂ ਤੁਹਾਡੇ ਡਿਵਾਈਸ 'ਤੇ ਹੀ ਚੱਲਦੀ ਹਾਂ। ਮੈਂ ਪੰਜਾਬੀ ਵਿੱਚ ਜਵਾਬ ਦਿਆਂਗੀ।`;
      }
      return "ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ **Friday**, ਤੁਹਾਡੀ ਨਿੱਜੀ AI ਸਹਾਇਕ ਹਾਂ.\n\nਮੈਂ ਤੁਹਾਡੇ ਡਿਵਾਈਸ 'ਤੇ ਹੀ ਚੱਲਦੀ ਹਾਂ। ਮੈਂ ਪੰਜਾਬੀ ਵਿੱਚ ਜਵਾਬ ਦਿਆਂਗੀ।";
    default:
      return name
        ? `Hello, ${name}! I'm **Friday**, your local AI assistant.`
        : `Hello! I'm **Friday**, your local AI assistant.`;
  }
}

function makeWelcomeMessage(
  sessionId: string,
  replyLanguage: ReplyLanguage = "english",
  userDisplayName = "",
): Message {
  return {
    id: `welcome-${sessionId}`,
    session_id: sessionId,
    role: "assistant",
    content: welcomeMessageForLanguage(replyLanguage, userDisplayName),
    created_at: new Date(0).toISOString(),
  };
}

function settingsToInput(settings: AppSettings): AppSettingsInput {
  return {
    auto_start_backend: settings.auto_start_backend,
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
    status &&
      status.state !== "unavailable" &&
      status.state !== "error",
  );
}

export function useAppController() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(
    null,
  );
  const [webSearchStatus, setWebSearchStatus] = useState<WebSearchStatus | null>(
    null,
  );
  const [knowledgeStatus, setKnowledgeStatus] = useState<KnowledgeStatus | null>(
    null,
  );
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSource[]>(
    [],
  );
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStats | null>(
    null,
  );
  const [currentModel, setCurrentModel] = useState("—");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [activeModelId, setActiveModelId] = useState<string>("");
  const [isSwitchingModel, setIsSwitchingModel] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);

  const pendingAssistantIdRef = useRef<string | null>(null);
  const pendingSessionIdRef = useRef<string | null>(null);
  const handledSendErrorRef = useRef(false);
  const activeSessionRef = useRef<Session | null>(null);
  const bufferedAnswerTokenRef = useRef("");
  const bufferedThoughtTokenRef = useRef("");
  const tokenFlushTimeoutRef = useRef<number | null>(null);
  const settingsSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSettingsSaveCountRef = useRef(0);
  const committedSettingsRef = useRef<AppSettingsInput | null>(null);
  const desiredSettingsRef = useRef<AppSettingsInput | null>(null);

  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  const applySavedSettingsState = (nextSettings: AppSettings) => {
    setSettings(nextSettings);
    setWebSearchEnabled(nextSettings.chat.web_assist_enabled);
    setKnowledgeEnabled(nextSettings.chat.knowledge_enabled);
    setThinkingEnabled(Boolean(nextSettings.chat.generation.thinking_enabled));
  };

  const flushBufferedTokens = () => {
    if (tokenFlushTimeoutRef.current !== null) {
      window.clearTimeout(tokenFlushTimeoutRef.current);
      tokenFlushTimeoutRef.current = null;
    }

    const answerChunk = bufferedAnswerTokenRef.current;
    const thoughtChunk = bufferedThoughtTokenRef.current;
    const pendingId = pendingAssistantIdRef.current;
    if ((!answerChunk && !thoughtChunk) || !pendingId) return;

    bufferedAnswerTokenRef.current = "";
    bufferedThoughtTokenRef.current = "";
    setMessages((previous) => {
      const mergePendingMessage = (message: Message): Message => {
        const nextThinking =
          getAssistantThinking(message.content_parts) + thoughtChunk;
        return {
          ...message,
          content: message.content + answerChunk,
          content_parts: nextThinking ? { thinking: nextThinking } : message.content_parts,
        };
      };

      const lastIndex = previous.length - 1;
      const lastMessage = lastIndex >= 0 ? previous[lastIndex] : undefined;
      if (lastMessage?.id === pendingId) {
        const nextMessages = previous.slice();
        nextMessages[lastIndex] = mergePendingMessage(lastMessage);
        return nextMessages;
      }

      const existingIndex = previous.findIndex((message) => message.id === pendingId);
      if (existingIndex === -1) {
        const sessionId =
          pendingSessionIdRef.current ??
          activeSessionRef.current?.id ??
          previous[previous.length - 1]?.session_id ??
          "local-session";

        return [
          ...previous,
          {
            id: pendingId,
            session_id: sessionId,
            role: "assistant",
            content: answerChunk,
            content_parts: thoughtChunk ? { thinking: thoughtChunk } : undefined,
            created_at: new Date().toISOString(),
          },
        ];
      }

      const nextMessages = previous.slice();
      nextMessages[existingIndex] = mergePendingMessage(previous[existingIndex]);
      return nextMessages;
    });
  };

  const clearBufferedTokens = () => {
    if (tokenFlushTimeoutRef.current !== null) {
      window.clearTimeout(tokenFlushTimeoutRef.current);
      tokenFlushTimeoutRef.current = null;
    }
    bufferedAnswerTokenRef.current = "";
    bufferedThoughtTokenRef.current = "";
  };

  const applyCompletedAssistantPayload = (payload: ChatDonePayload) => {
    const pendingId = pendingAssistantIdRef.current;
    if (!pendingId) return;

    const hasFinalContent =
      typeof payload.content === "string" ||
      hasOwnPayloadField(payload, "content");
    const hasFinalContentParts = hasOwnPayloadField(payload, "contentParts");
    if (!hasFinalContent && !hasFinalContentParts) {
      return;
    }

    setMessages((previous) => {
      const existingIndex = previous.findIndex((message) => message.id === pendingId);
      if (existingIndex === -1) {
        const sessionId =
          pendingSessionIdRef.current ??
          activeSessionRef.current?.id ??
          previous[previous.length - 1]?.session_id ??
          "local-session";
        return [
          ...previous,
          {
            id: pendingId,
            session_id: sessionId,
            role: "assistant",
            content: typeof payload.content === "string" ? payload.content : "",
            content_parts: hasFinalContentParts ? payload.contentParts : undefined,
            created_at: new Date().toISOString(),
          },
        ];
      }

      const nextMessages = previous.slice();
      const existing = nextMessages[existingIndex];
      nextMessages[existingIndex] = {
        ...existing,
        content: hasFinalContent
          ? typeof payload.content === "string"
            ? payload.content
            : ""
          : existing.content,
        content_parts: hasFinalContentParts
          ? payload.contentParts
          : existing.content_parts,
      };
      return nextMessages;
    });
  };

  const clearPendingGenerationState = () => {
    clearBufferedTokens();
    pendingAssistantIdRef.current = null;
    pendingSessionIdRef.current = null;
  };

  const resetGenerationUiState = () => {
    clearPendingGenerationState();
    setIsGenerating(false);
    setGenerationStatus(null);
  };

  const scheduleBufferedTokenFlush = () => {
    if (tokenFlushTimeoutRef.current !== null) return;
    tokenFlushTimeoutRef.current = window.setTimeout(() => {
      tokenFlushTimeoutRef.current = null;
      flushBufferedTokens();
    }, TOKEN_FLUSH_INTERVAL_MS);
  };

  const removePendingAssistantIfEmpty = () => {
    const pendingId = pendingAssistantIdRef.current;
    if (!pendingId) return;

    setMessages((previous) =>
      previous.filter(
        (message) =>
          !(
            message.id === pendingId &&
            message.content.trim() === "" &&
            getAssistantThinking(message.content_parts).trim() === ""
          ),
      ),
    );
  };

  const appendAssistantError = (message: string) => {
    setMessages((previous) => {
      const sessionId =
        activeSessionRef.current?.id ??
        previous[0]?.session_id ??
        "local-session";
      return [...previous, makeAssistantMessage(sessionId, `⚠️ ${message}`)];
    });
  };

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
    const [statusResult, sourcesResult, statsResult] = await Promise.allSettled([
      includeStatus ? detectKnowledgeStatus() : Promise.resolve(knowledgeStatus),
      invoke<KnowledgeSource[]>("knowledge_list_sources"),
      invoke<KnowledgeStats>("knowledge_stats"),
    ]);

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

    if (sourcesResult.status === "fulfilled" && Array.isArray(sourcesResult.value)) {
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

  const warmBackendIfNeeded = async (statusValue: BackendStatus | null | undefined) => {
    if (!statusValue || statusValue.connected || statusValue.state !== "ready") {
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
      // Warmup is opportunistic; the regular send path will still start the daemon.
      return statusValue;
    }
  };

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
      setMessages(payload.messages);
      applySavedSettingsState(payload.settings);
      setBackendStatus(payload.backendStatus);
      setWebSearchStatus(
        payload.webSearchStatus ?? unavailableWebSearchStatus(),
      );
      setKnowledgeStatus(
        payload.knowledgeStatus ?? unavailableKnowledgeStatus(),
      );
      const [inventoryResult, knowledgeResult] = await Promise.allSettled([
        refreshModelInventory(),
        refreshKnowledge({ includeStatus: false }),
      ]);
      if (inventoryResult.status === "rejected") {
        console.warn("refreshModelInventory during bootstrap failed:", inventoryResult.reason);
      }
      if (knowledgeResult.status === "rejected") {
        console.warn("refreshKnowledge during bootstrap failed:", knowledgeResult.reason);
      }
      void warmBackendIfNeeded(payload.backendStatus);
      if (
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
      setMessages(selection.messages);
    }
    setSessions(nextSessions);
    clearPendingGenerationState();
  };

  useEffect(() => {
    const registerListeners = async () => {
      const unlistenToken = await listen<ChatTokenPayload>(
        "chat-token",
        (event) => {
          if (
            !pendingAssistantIdRef.current ||
            event.payload.sessionId !== pendingSessionIdRef.current
          ) {
            return;
          }

          if (event.payload.kind === "thought") {
            bufferedThoughtTokenRef.current += event.payload.token;
          } else {
            bufferedAnswerTokenRef.current += event.payload.token;
          }
          setGenerationStatus(null);
          scheduleBufferedTokenFlush();
        },
      );

      const unlistenDone = await listen<ChatDonePayload>("chat-done", (event) => {
        if (event.payload.sessionId !== pendingSessionIdRef.current) {
          return;
        }

        flushBufferedTokens();
        applyCompletedAssistantPayload(event.payload);
        setIsGenerating(false);
        setGenerationStatus(null);
        setCurrentModel(formatModelLabel(event.payload.model));

        if (!event.payload.hasContent) {
          removePendingAssistantIfEmpty();
        }

        clearPendingGenerationState();
        void refreshBackendStatus({ includeModelInventory: false }).catch(
          () => undefined,
        );
      });

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
          if (!pendingSessionIdRef.current) {
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
        },
      );

      const unlistenToolCall = await listen<ToolCallEvent>(
        "tool-call-start",
        (event) => {
          if (event.payload.sessionId !== pendingSessionIdRef.current) {
            return;
          }

          setGenerationStatus(generationStatusForToolCall(event.payload.name));
        },
      );

      const unlistenToolResult = await listen<ToolResultEvent>(
        "tool-call-result",
        (event) => {
          if (
            event.payload.sessionId !== pendingSessionIdRef.current ||
            !pendingSessionIdRef.current
          ) {
            return;
          }

          const nextStatus = generationStatusForToolResult(event.payload.name);
          if (nextStatus) {
            setGenerationStatus(nextStatus);
          }
        },
      );

      const unlistenError = await listen<string | ChatErrorPayload>(
        "chat-error",
        (event) => {
          const payload = normalizeChatErrorPayload(event.payload);
          const matchesPendingSession =
            !!payload.sessionId &&
            payload.sessionId === pendingSessionIdRef.current;
          const isActiveSessionError =
            matchesPendingSession &&
            payload.sessionId === activeSessionRef.current?.id;

          handledSendErrorRef.current = matchesPendingSession;
          if (isActiveSessionError) {
            flushBufferedTokens();
            setIsGenerating(false);
            setGenerationStatus(null);
            removePendingAssistantIfEmpty();
            clearPendingGenerationState();
            appendAssistantError(payload.message);
          }
          void refreshBackendStatus({ includeModelInventory: false }).catch(
            () => undefined,
          );
        },
      );

      return () => {
        unlistenToken();
        unlistenDone();
        unlistenActivity();
        unlistenWebSearchStatus();
        unlistenKnowledgeStatus();
        unlistenToolCall();
        unlistenToolResult();
        unlistenError();
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
      setMessages([makeAssistantMessage("bootstrap", `⚠️ ${message}`)]);
      setIsBootstrapping(false);
    });

    return () => {
      cancelled = true;
      clearPendingGenerationState();
      dispose?.();
    };
  }, []);

  const createSession = async () => {
    if (isGenerating) return;

    const session = await invoke<Session>("create_session", {
      title: "New chat",
    });
    setSessions((previous) => [
      session,
      ...previous.filter((item) => item.id !== session.id),
    ]);
    setActiveSession(session);
    setMessages([]);
    resetGenerationUiState();
  };

  const selectSession = async (sessionId: string) => {
    if (isGenerating) return;

    const result = await invoke<SessionSelectionResult>("select_session", {
      sessionId,
    });
    setActiveSession(result.session);
    setMessages(result.messages);
    resetGenerationUiState();
  };

  const deleteSession = async (sessionId: string) => {
    if (isGenerating) return;

    await invoke("delete_session", { sessionId });
    const deletedActiveSession = activeSessionRef.current?.id === sessionId;
    const nextSessions = await invoke<Session[]>("list_sessions");
    setSessions(nextSessions);
    resetGenerationUiState();

    if (
      !deletedActiveSession &&
      activeSessionRef.current?.id &&
      nextSessions.some((session) => session.id === activeSessionRef.current?.id)
    ) {
      return;
    }

    const fallbackSession = nextSessions[0] ?? null;
    if (!fallbackSession) {
      setActiveSession(null);
      setMessages([]);
      return;
    }

    setActiveSession(fallbackSession);
    setMessages([]);

    const selection = await invoke<SessionSelectionResult>("select_session", {
      sessionId: fallbackSession.id,
    });
    setActiveSession(selection.session);
    setMessages(selection.messages);
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

    // Build display content for the user bubble
    let displayContent = trimmed;
    if (hasAttachments) {
      const fileNames = readyAttachments.map((attachment) => attachment.name);
      if (fileNames.length > 0) {
        const fileTag = `📎 ${fileNames.join(", ")}`;
        displayContent = trimmed ? `${fileTag}\n${trimmed}` : fileTag;
      }
    }

    // Build serializable attachments for the backend
    const serializedAttachments = hasAttachments
      ? readyAttachments
          .map((a) => ({
            path: a.path,
            name: a.name,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            content: a.content
              ? a.content.text
                ? { text: a.content.text }
                : a.content.dataUrl
                  ? { dataUrl: a.content.dataUrl }
                  : a.content.path
                    ? { path: a.content.path }
                  : null
              : null,
          }))
      : null;

    handledSendErrorRef.current = false;
    const pendingId = makeId();
    pendingAssistantIdRef.current = pendingId;
    pendingSessionIdRef.current = sessionId;
    setIsGenerating(true);
    const needsWebSearchStartup =
      effectiveWebAssistEnabled && webSearchStatus?.state !== "ready";
    setGenerationStatus(
      needsWebSearchStartup
        ? webSearchStartupMessage(webSearchStatus)
        : backendStatus?.connected
          ? "Friday is thinking…"
          : "Starting local model…",
    );
    setMessages((previous) => [
      ...previous,
      {
        id: makeId(),
        session_id: sessionId,
        role: "user",
        content: displayContent,
        created_at: new Date().toISOString(),
      },
    ]);

    try {
      await invoke("send_message", {
        request: {
          sessionId,
          message:
            trimmed ||
            (hasAttachments
              ? "What can you tell me about these files?"
              : trimmed),
          attachments: serializedAttachments,
          thinkingEnabled: effectiveThinkingEnabled,
          webAssistEnabled: effectiveWebAssistEnabled,
          knowledgeEnabled: effectiveKnowledgeEnabled,
        },
      });
      if (pendingSessionIdRef.current === sessionId) {
        flushBufferedTokens();
        setIsGenerating(false);
        setGenerationStatus(null);
      }
      await refreshSessionState(sessionId);
    } catch (error) {
      flushBufferedTokens();
      setIsGenerating(false);
      setGenerationStatus(null);
      removePendingAssistantIfEmpty();
      clearPendingGenerationState();

      if (
        handledSendErrorRef.current &&
        activeSessionRef.current?.id === sessionId
      ) {
        await refreshSessionState(sessionId).catch(() => undefined);
      } else if (activeSessionRef.current?.id === sessionId) {
        appendAssistantError(toErrorMessage(error));
      }
    }
  };

  const cancelGeneration = async () => {
    setGenerationStatus("Stopping…");
    await invoke("cancel_generation");
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
        committedSettingsRef.current = savedInput;
        if (settingsInputsEqual(desiredSettingsRef.current, mergedInput)) {
          desiredSettingsRef.current = savedInput;
          applySavedSettingsState(saved);
        }
        try {
          await refreshBackendStatus({ includeModelInventory: false });
        } catch (error) {
          console.warn("refreshBackendStatus after save_settings failed:", error);
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
      console.error("setReplyLanguage failed:", err);
      alert(`Language switch failed: ${err}`);
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

  return {
    sessions,
    activeSession,
    messages,
    settings,
    backendStatus,
    webSearchStatus,
    knowledgeStatus,
    knowledgeSources,
    knowledgeStats,
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
  };
}
