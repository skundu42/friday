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
  Message,
  ModelInfo,
  ReplyLanguage,
  Session,
  SessionSelectionResult,
  ToolCallEvent,
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

function normalizeChatErrorPayload(
  payload: string | ChatErrorPayload,
): ChatErrorPayload {
  if (typeof payload === "string") {
    return { message: payload };
  }
  return payload;
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
    chat: {
      reply_language: settings.chat.reply_language,
      max_tokens: settings.chat.max_tokens,
      web_assist_enabled: settings.chat.web_assist_enabled,
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

export function useAppController() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(
    null,
  );
  const [currentModel, setCurrentModel] = useState("—");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [activeModelId, setActiveModelId] = useState<string>("");
  const [isSwitchingModel, setIsSwitchingModel] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
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

  const clearPendingGenerationState = () => {
    clearBufferedTokens();
    pendingAssistantIdRef.current = null;
    pendingSessionIdRef.current = null;
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

  const refreshBackendStatus = async () => {
    const [status] = await Promise.all([
      invoke<BackendStatus>("detect_backend"),
      refreshModelInventory(),
    ]);
    setBackendStatus(status);
    if (status.models[0]) {
      setCurrentModel(formatModelLabel(status.models[0]));
    }
    return status;
  };

  const warmBackendIfNeeded = async (
    settingsValue: AppSettings | null | undefined,
    statusValue: BackendStatus | null | undefined,
  ) => {
    if (!settingsValue?.auto_start_backend) {
      return;
    }
    if (!statusValue || statusValue.connected || statusValue.state !== "ready") {
      return;
    }

    try {
      const warmed = await invoke<BackendStatus>("warm_backend");
      setBackendStatus(warmed);
      if (warmed.models[0]) {
        setCurrentModel(formatModelLabel(warmed.models[0]));
      }
    } catch {
      // Warmup is opportunistic; the regular send path will still start the daemon.
    }
  };

  const bootstrap = async () => {
    setIsBootstrapping(true);
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
      await refreshModelInventory();
      void warmBackendIfNeeded(payload.settings, payload.backendStatus);
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
        setIsGenerating(false);
        setGenerationStatus(null);
        setCurrentModel(formatModelLabel(event.payload.model));

        if (!event.payload.hasContent) {
          removePendingAssistantIfEmpty();
        }

        clearPendingGenerationState();
        void refreshBackendStatus().catch(() => undefined);
      });

      const unlistenActivity = await listen<{ model?: string }>(
        "activity",
        (event) => {
          if (event.payload.model) {
            setCurrentModel(formatModelLabel(event.payload.model));
          }
        },
      );

      const unlistenToolCall = await listen<ToolCallEvent>(
        "tool-call-start",
        (event) => {
          if (event.payload.sessionId !== pendingSessionIdRef.current) {
            return;
          }

          switch (event.payload.name) {
            case "web_search":
              setGenerationStatus("Searching the web…");
              break;
            case "web_fetch":
              setGenerationStatus("Reading the page…");
              break;
            case "file_read":
              setGenerationStatus("Reading local files…");
              break;
            case "list_directory":
              setGenerationStatus("Inspecting local files…");
              break;
            case "calculate":
              setGenerationStatus("Calculating…");
              break;
            default:
              setGenerationStatus("Working…");
              break;
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
          void refreshBackendStatus().catch(() => undefined);
        },
      );

      return () => {
        unlistenToken();
        unlistenDone();
        unlistenActivity();
        unlistenToolCall();
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
    clearPendingGenerationState();
    setIsGenerating(false);
  };

  const selectSession = async (sessionId: string) => {
    if (isGenerating) return;

    const result = await invoke<SessionSelectionResult>("select_session", {
      sessionId,
    });
    setActiveSession(result.session);
    setMessages(result.messages);
    clearPendingGenerationState();
    setIsGenerating(false);
  };

  const deleteSession = async (sessionId: string) => {
    if (isGenerating) return;

    await invoke("delete_session", { sessionId });
    await bootstrap();
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
    setGenerationStatus(
      backendStatus?.connected ? "Friday is thinking…" : "Starting local model…",
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
        sessionId,
        message:
          trimmed ||
          (hasAttachments
            ? "What can you tell me about these files?"
            : trimmed),
        attachments: serializedAttachments,
        thinkingEnabled: effectiveThinkingEnabled,
      });
      flushBufferedTokens();
      setIsGenerating(false);
      setGenerationStatus(null);
      await refreshSessionState(sessionId);
    } catch (error) {
      flushBufferedTokens();
      setIsGenerating(false);
      setGenerationStatus(null);
      removePendingAssistantIfEmpty();
      clearPendingGenerationState();

      if (
        !handledSendErrorRef.current &&
        activeSessionRef.current?.id === sessionId
      ) {
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
        await refreshBackendStatus();
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
        chat: {
          reply_language: lang,
          max_tokens: settings.chat.max_tokens,
          web_assist_enabled: settings.chat.web_assist_enabled,
          generation: settings.chat.generation,
        },
      });
    } catch (err) {
      console.error("setReplyLanguage failed:", err);
      alert(`Language switch failed: ${err}`);
    }
  };

  const toggleWebSearch = async () => {
    if (!backendStatus?.supports_native_tools || !settings) {
      return;
    }
    const next = !webSearchEnabled;
    setWebSearchEnabled(next);
    try {
      await saveAppSettings({
        auto_start_backend: settings.auto_start_backend,
        user_display_name: settings.user_display_name,
        chat: {
          reply_language: settings.chat.reply_language,
          max_tokens: settings.chat.max_tokens,
          web_assist_enabled: next,
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
        chat: {
          reply_language: settings.chat.reply_language,
          max_tokens: settings.chat.max_tokens,
          web_assist_enabled: settings.chat.web_assist_enabled,
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

  return {
    sessions,
    activeSession,
    messages,
    settings,
    backendStatus,
    currentModel,
    activeModelId,
    configurableModels,
    isBootstrapping,
    isGenerating,
    isSavingSettings,
    isSwitchingModel,
    createSession,
    selectSession,
    deleteSession,
    sendMessage,
    cancelGeneration,
    refreshBackendStatus,
    refreshModelInventory,
    saveAppSettings,
    setReplyLanguage,
    selectModel,
    webSearchEnabled,
    thinkingEnabled,
    generationStatus,
    nativeToolSupportAvailable: backendStatus?.supports_native_tools ?? false,
    audioInputAvailable: backendStatus?.supports_audio_input ?? false,
    thinkingAvailable: backendStatus?.supports_thinking ?? false,
    toggleWebSearch,
    toggleThinking,
  };
}
