import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Select, Tag, Typography } from "antd";
import {
  SendOutlined,
  StopOutlined,
  ThunderboltOutlined,
  PlusOutlined,
  AudioOutlined,
  CloseCircleFilled,
  FileTextOutlined,
  FileImageOutlined,
  LoadingOutlined,
  GlobalOutlined,
  DatabaseOutlined,
  MenuOutlined,
} from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import MessageBubble from "./MessageBubble";
import AppLogo from "./AppLogo";
import type {
  BackendStatus,
  FileAttachment,
  FridayRenderableMessage,
  KnowledgeStatus,
  ReplyLanguage,
  WebSearchStatus,
} from "../types";

const { TextArea } = Input;
const { Text } = Typography;

const SUPPORTED_EXTENSIONS = [
  "txt",
  "md",
  "csv",
  "json",
  "xml",
  "yaml",
  "yml",
  "toml",
  "rs",
  "py",
  "js",
  "ts",
  "tsx",
  "jsx",
  "html",
  "css",
  "sql",
  "sh",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "rb",
  "php",
  "swift",
  "pdf",
  "docx",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "wav",
  "mp3",
  "m4a",
  "ogg",
  "webm",
  "log",
  "env",
  "ini",
  "cfg",
];
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const AUDIO_EXTENSIONS = ["wav", "mp3", "m4a", "ogg", "webm"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
const SPECIAL_ATTACHMENT_NAMES = [".env", ".gitignore", "dockerfile", "makefile"];
const IMAGE_INPUT_UNAVAILABLE_MESSAGE =
  "Image attachments are unavailable with the current local backend.";

function userFacingWebSearchStatusMessage(
  backendStatus: BackendStatus | null,
  webSearchAvailable: boolean,
  isWebSearchActive: boolean,
  webSearchStatus: WebSearchStatus | null,
): string | null {
  if (!backendStatus?.supports_native_tools) {
    return "Web search is unavailable with the current local backend.";
  }

  const state = webSearchStatus?.state;
  const message = webSearchStatus?.message;

  if (!webSearchAvailable) {
    if (state === "stopped" || state === "needs_install") {
      return null;
    }
    return message ?? "Local web search is unavailable.";
  }

  if (isWebSearchActive && state !== "ready") {
    if (state === "stopped" || state === "needs_install") {
      return null;
    }
    return message ?? "Local web search is preparing.";
  }

  return null;
}

function userFacingKnowledgeStatusMessage(
  knowledgeAvailable: boolean,
  knowledgeEnabled: boolean,
  knowledgeStatus: KnowledgeStatus | null,
): string | null {
  if (!knowledgeAvailable) {
    return knowledgeStatus?.message ?? "Knowledge is unavailable.";
  }

  if (!knowledgeEnabled) {
    return null;
  }

  switch (knowledgeStatus?.state) {
    case "needs_models":
      return "Knowledge models will download on first use.";
    case "downloading_models":
      return knowledgeStatus.message || "Preparing Knowledge models…";
    case "indexing":
      return knowledgeStatus.message || "Knowledge is indexing sources…";
    case "error":
      return knowledgeStatus.message || "Knowledge is unavailable.";
    case "ready":
      return "Grounding this reply against your local library.";
    default:
      return knowledgeStatus?.message ?? null;
  }
}

interface ChatPaneProps {
  messages: FridayRenderableMessage[];
  isGenerating: boolean;
  generationStatus?: string | null;
  activeSessionTitle: string;
  userDisplayName?: string;
  replyLanguage: ReplyLanguage;
  backendStatus: BackendStatus | null;
  onLanguageChange: (lang: ReplyLanguage) => void;
  onToggleSidebar: () => void;
  isSidebarOpen: boolean;
  isNarrowLayout?: boolean;
  onSendMessage: (
    content: string,
    attachments?: FileAttachment[],
  ) => Promise<void> | void;
  onCancelGeneration: () => Promise<void> | void;
  webSearchEnabled?: boolean;
  knowledgeEnabled?: boolean;
  thinkingEnabled?: boolean;
  webSearchAvailable?: boolean;
  webSearchStatus?: WebSearchStatus | null;
  knowledgeAvailable?: boolean;
  knowledgeStatus?: KnowledgeStatus | null;
  thinkingAvailable?: boolean;
  audioInputAvailable?: boolean;
  onToggleWebSearch?: () => void;
  onToggleKnowledge?: () => void;
  onToggleThinking?: () => void;
}

const REPLY_LANGUAGE_OPTIONS: { label: string; value: ReplyLanguage }[] = [
  { label: "English", value: "english" },
  { label: "Hindi", value: "hindi" },
  { label: "Bengali", value: "bengali" },
  { label: "Marathi", value: "marathi" },
  { label: "Tamil", value: "tamil" },
  { label: "Punjabi", value: "punjabi" },
];

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return <FileImageOutlined />;
  if (mimeType.startsWith("audio/")) return <AudioOutlined />;
  return <FileTextOutlined />;
}

function fileSizeLimitMessage(bytes: number) {
  return `File too large: ${formatFileSize(bytes)}. Maximum is 10.0 MB.`;
}

function makeBrowserAttachmentId(name: string) {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`
  ) + `:${name}`;
}

function isSupportedAttachmentName(name: string) {
  const normalizedName = name.toLowerCase();
  const ext = normalizedName.split(".").pop() || "";
  return (
    SUPPORTED_EXTENSIONS.includes(ext) ||
    SPECIAL_ATTACHMENT_NAMES.includes(normalizedName)
  );
}

function isImageAttachmentName(name: string) {
  const ext = name.toLowerCase().split(".").pop() || "";
  return IMAGE_EXTENSIONS.includes(ext);
}

function humanizeBackendState(state?: string) {
  switch (state) {
    case "ready":
      return "Ready";
    case "runtime_missing":
      return "Setup required";
    case "model_missing":
      return "Model missing";
    case "insufficient_ram":
      return "Insufficient RAM";
    case "start_failed":
      return "Unavailable";
    default:
      return "Disconnected";
  }
}

function backendStatusTone(backendStatus: BackendStatus | null) {
  if (backendStatus?.connected) return "success";
  if (backendStatus?.state === "ready") return "processing";
  return "danger";
}

function isGenericThinkingStatus(status?: string | null) {
  if (!status) return false;
  return status === "Friday is thinking…" || status === "Friday is thinking...";
}

export default function ChatPane({
  messages,
  isGenerating,
  generationStatus = null,
  activeSessionTitle,
  userDisplayName = "",
  replyLanguage,
  backendStatus,
  onLanguageChange,
  onToggleSidebar,
  isSidebarOpen,
  isNarrowLayout = false,
  onSendMessage,
  onCancelGeneration,
  webSearchEnabled = false,
  knowledgeEnabled = false,
  thinkingEnabled = false,
  webSearchAvailable = false,
  webSearchStatus = null,
  knowledgeAvailable = false,
  knowledgeStatus = null,
  thinkingAvailable = false,
  audioInputAvailable = false,
  onToggleWebSearch,
  onToggleKnowledge,
  onToggleThinking,
}: ChatPaneProps) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [microphonePermission, setMicrophonePermission] = useState<
    "granted" | "prompt" | "denied" | "unknown"
  >("unknown");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const attachmentsRef = useRef<FileAttachment[]>([]);
  const shouldAutoScrollRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const isUnmountingRef = useRef(false);
  const audioRecordingSupported =
    audioInputAvailable &&
    typeof navigator !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;
  const imageInputAvailable = backendStatus?.supports_image_input ?? false;

  const cleanupTempAttachments = useCallback(async (items: FileAttachment[]) => {
    const tempPaths = Array.from(
      new Set(
        items
          .filter((attachment) => attachment.isTemp && attachment.path)
          .map((attachment) => attachment.path),
      ),
    );

    await Promise.allSettled(
      tempPaths.map((path) => invoke("delete_temp_file", { path })),
    );
  }, []);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    const hasNewMessage = messages.length !== previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;

    if (!shouldAutoScrollRef.current) {
      return;
    }

    chatEndRef.current?.scrollIntoView({
      behavior: isGenerating ? "auto" : hasNewMessage ? "smooth" : "auto",
    });
  }, [isGenerating, messages]);

  useEffect(() => {
    return () => {
      isUnmountingRef.current = true;
      mediaRecorderRef.current?.stop();
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      void cleanupTempAttachments(attachmentsRef.current);
    };
  }, [cleanupTempAttachments]);

  useEffect(() => {
    let cancelled = false;
    let permissionStatus: PermissionStatus | null = null;

    const syncPermissionState = async () => {
      if (
        typeof navigator === "undefined" ||
        !("permissions" in navigator) ||
        typeof navigator.permissions?.query !== "function"
      ) {
        return;
      }

      try {
        const status = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });
        permissionStatus = status;
        if (!cancelled) {
          setMicrophonePermission(
            status.state as "granted" | "prompt" | "denied",
          );
        }
        status.onchange = () => {
          if (!cancelled) {
            setMicrophonePermission(
              status.state as "granted" | "prompt" | "denied",
            );
          }
        };
      } catch {
        // Permissions API support is inconsistent; rely on getUserMedia fallback.
      }
    };

    void syncPermissionState();

    return () => {
      cancelled = true;
      if (permissionStatus) {
        permissionStatus.onchange = null;
      }
    };
  }, []);

  const handleSend = async () => {
    const text = input.trim();
    const hasLoadingAttachments = attachments.some(
      (attachment) => attachment.status === "loading",
    );
    const hasReadyAttachments = attachments.some(
      (attachment) => attachment.status === "ready",
    );

    if ((!text && !hasReadyAttachments) || hasLoadingAttachments || isGenerating) {
      return;
    }

    setInput("");
    const attachedFiles = [...attachments];
    setAttachments([]);
    try {
      await onSendMessage(
        text || "What can you tell me about these files?",
        attachedFiles,
      );
    } finally {
      await cleanupTempAttachments(attachedFiles);
    }
  };

  const handleCancel = async () => {
    await onCancelGeneration();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if ((event.nativeEvent as KeyboardEvent).isComposing) {
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    } else if (event.key === "Escape" && isGenerating) {
      event.preventDefault();
      void handleCancel();
    }
  };

  const loadFile = useCallback(
    async (filePath: string): Promise<FileAttachment> => {
      const name = filePath.split("/").pop()?.split("\\").pop() || "file";

      if (isImageAttachmentName(name) && !imageInputAvailable) {
        const unsupported: FileAttachment = {
          path: filePath,
          name,
          mimeType: "image/unsupported",
          sizeBytes: 0,
          isTemp: false,
          status: "error",
          error: IMAGE_INPUT_UNAVAILABLE_MESSAGE,
        };
        setAttachments((prev) => [...prev, unsupported]);
        return unsupported;
      }

      const attachment: FileAttachment = {
        path: filePath,
        name,
        mimeType: "",
        sizeBytes: 0,
        isTemp: false,
        status: "loading",
      };

      setAttachments((prev) => [...prev, attachment]);

      try {
        const result = await invoke<{
          name: string;
          mimeType: string;
          sizeBytes: number;
          content: {
            type: string;
            text?: string;
            dataUrl?: string;
            data_url?: string;
            path?: string;
            note?: string;
          };
        }>("read_file_context", { path: filePath });

        const imageDataUrl = result.content.dataUrl ?? result.content.data_url;

        const loaded: FileAttachment = {
          path: filePath,
          name: result.name,
          mimeType: result.mimeType,
          sizeBytes: result.sizeBytes,
          isTemp: false,
          status: result.content.type === "unsupported" ? "error" : "ready",
          error:
            result.content.type === "unsupported"
              ? result.content.note
              : undefined,
          content:
            result.content.type === "text"
              ? { text: result.content.text }
              : result.content.type === "image"
                ? { dataUrl: imageDataUrl }
                : result.content.type === "audio"
                  ? { path: result.content.path }
                  : null,
        };

        setAttachments((prev) =>
          prev.map((a) =>
            a.path === filePath && a.status === "loading" ? loaded : a,
          ),
        );
        return loaded;
      } catch (err) {
        const errorMsg = typeof err === "string" ? err : "Failed to read file";
        setAttachments((prev) =>
          prev.map((a) =>
            a.path === filePath && a.status === "loading"
              ? { ...a, status: "error" as const, error: errorMsg }
              : a,
          ),
        );
        return { ...attachment, status: "error", error: errorMsg };
      }
    },
    [imageInputAvailable],
  );

  const handlePickFile = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Documents, Images & Audio",
            extensions: SUPPORTED_EXTENSIONS,
          },
          { name: "All Files", extensions: ["*"] },
        ],
      });

      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      void Promise.allSettled(paths.map((path) => loadFile(path)));
    } catch {
      // User cancelled or dialog error
    }
  };

  const handleRemoveAttachment = (path: string) => {
    setAttachments((prev) => {
      const removed = prev.find((attachment) => attachment.path === path);
      if (removed?.isTemp) {
        void cleanupTempAttachments([removed]);
      }

      return prev.filter((a) => a.path !== path);
    });
  };

  const saveBrowserBinaryFile = useCallback(async (
    file: globalThis.File,
  ): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    return invoke<string>("save_temp_file", {
      name: file.name,
      data: Array.from(bytes),
    });
  }, []);

  const readFileAsDataUrl = useCallback((file: globalThis.File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }, []);

  const loadBrowserFile = useCallback(async (file: globalThis.File) => {
    const attachmentId = makeBrowserAttachmentId(file.name);
    const name = file.name;
    const ext = name.split(".").pop()?.toLowerCase() || "";
    const sizeBytes = file.size;
    const mimeType = file.type || "application/octet-stream";
    let tempPathToCleanup: string | null = null;
    const isImage = IMAGE_EXTENSIONS.includes(ext);
    const isAudio = AUDIO_EXTENSIONS.includes(ext);
    const isPdf = ext === "pdf";
    const isDocx = ext === "docx";

    if (isImage && !imageInputAvailable) {
      setAttachments((prev) => [
        ...prev,
        {
          path: attachmentId,
          name,
          mimeType,
          sizeBytes,
          status: "error",
          error: IMAGE_INPUT_UNAVAILABLE_MESSAGE,
        },
      ]);
      return;
    }

    if (sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
      setAttachments((prev) => [
        ...prev,
        {
          path: attachmentId,
          name,
          mimeType,
          sizeBytes,
          status: "error",
          error: fileSizeLimitMessage(sizeBytes),
        },
      ]);
      return;
    }

    const attachment: FileAttachment = {
      path: attachmentId,
      name,
      mimeType,
      sizeBytes,
      isTemp: false,
      status: "loading",
    };

    setAttachments((prev) => [...prev, attachment]);

    try {
      if (isImage) {
        const dataUrl = await readFileAsDataUrl(file);
        setAttachments((prev) =>
          prev.map((a) =>
            a.path === attachmentId && a.status === "loading"
              ? { ...a, status: "ready" as const, content: { dataUrl } }
              : a,
          ),
        );
      } else if (isAudio) {
        const tempPath = await saveBrowserBinaryFile(file);
        tempPathToCleanup = tempPath;
        let attachmentFound = false;
        setAttachments((prev) =>
          prev.map((a) => {
            if (a.path === attachmentId && a.status === "loading") {
              attachmentFound = true;
              return {
                ...a,
                path: tempPath,
                isTemp: true,
                status: "ready" as const,
                content: { path: tempPath },
              };
            }

            return a;
          }),
        );
        if (!attachmentFound) {
          await cleanupTempAttachments([
            { ...attachment, path: tempPath, isTemp: true },
          ]);
        }
        tempPathToCleanup = null;
      } else if (!isPdf && !isDocx) {
        const text = await file.text();
        setAttachments((prev) =>
          prev.map((a) =>
            a.path === attachmentId && a.status === "loading"
              ? { ...a, status: "ready" as const, content: { text } }
              : a,
          ),
        );
      } else {
        const tempPath = await saveBrowserBinaryFile(file);
        tempPathToCleanup = tempPath;
        const result = await invoke<{
          name: string;
          mimeType: string;
          sizeBytes: number;
          content: { type: string; text?: string };
        }>("read_file_context", { path: tempPath });

        let attachmentFound = false;
        setAttachments((prev) =>
          prev.map((a) => {
            if (a.path === attachmentId && a.status === "loading") {
              attachmentFound = true;
              return {
                ...a,
                path: tempPath,
                isTemp: true,
                status: "ready" as const,
                mimeType: result.mimeType,
                content: { text: result.content.text },
              };
            }

            return a;
          }),
        );
        if (!attachmentFound) {
          await cleanupTempAttachments([
            { ...attachment, path: tempPath, isTemp: true },
          ]);
        }
        tempPathToCleanup = null;
      }
    } catch (err) {
      if (tempPathToCleanup) {
        await cleanupTempAttachments([
          { ...attachment, path: tempPathToCleanup, isTemp: true },
        ]);
      }
      const errorMsg = typeof err === "string" ? err : "Failed to read file";
      setAttachments((prev) =>
        prev.map((a) =>
          a.path === attachmentId && a.status === "loading"
            ? { ...a, status: "error" as const, error: errorMsg }
            : a,
        ),
      );
    }
  }, [
    cleanupTempAttachments,
    imageInputAvailable,
    readFileAsDataUrl,
    saveBrowserBinaryFile,
  ]);

  // Drag & Drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      const supportedFiles = Array.from(files).filter((file) =>
        isSupportedAttachmentName(file.name),
      );
      void Promise.allSettled(
        supportedFiles.map((file) => loadBrowserFile(file)),
      );
    },
    [loadBrowserFile],
  );

  const bestRecordingMimeType = () => {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];
    return (
      candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ??
      ""
    );
  };

  const startRecording = (stream: MediaStream) => {
    recordingStreamRef.current = stream;

    const mimeType = bestRecordingMimeType();
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    recordingChunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordingChunksRef.current.push(event.data);
      }
    };
    recorder.onerror = () => {
      const activeStream = recordingStreamRef.current;
      mediaRecorderRef.current = null;
      recordingStreamRef.current = null;
      recordingChunksRef.current = [];
      activeStream?.getTracks().forEach((track) => track.stop());
      if (!isUnmountingRef.current) {
        setAudioError("Audio recording failed.");
        setIsRecordingAudio(false);
      }
    };
    recorder.onstop = () => {
      const blob = new Blob(recordingChunksRef.current, {
        type: recorder.mimeType || "audio/webm",
      });
      const streamToStop = recordingStreamRef.current;
      mediaRecorderRef.current = null;
      recordingStreamRef.current = null;
      recordingChunksRef.current = [];
      streamToStop?.getTracks().forEach((track) => track.stop());
      if (!isUnmountingRef.current) {
        setIsRecordingAudio(false);
      }

      if (isUnmountingRef.current || blob.size === 0) {
        return;
      }

      const extension = blob.type.includes("mp4")
        ? "m4a"
        : blob.type.includes("ogg")
          ? "ogg"
          : "webm";
      const file = new File([blob], `recording-${Date.now()}.${extension}`, {
        type: blob.type || `audio/${extension}`,
      });
      void loadBrowserFile(file);
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    setIsRecordingAudio(true);
  };

  const handleToggleRecording = async () => {
    if (isRecordingAudio) {
      mediaRecorderRef.current?.stop();
      return;
    }

    if (!audioRecordingSupported) {
      setAudioError("Audio recording is not available in this environment.");
      return;
    }

    try {
      setAudioError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicrophonePermission("granted");
      startRecording(stream);
    } catch (error) {
      const errorName =
        typeof error === "object" && error && "name" in error
          ? String(error.name)
          : "";

      if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
        setMicrophonePermission("denied");
        setAudioError(
          "Microphone access was denied. Enable Friday in System Settings > Privacy & Security > Microphone, then try again.",
        );
      } else if (errorName === "NotFoundError") {
        setAudioError("No microphone was found on this device.");
      } else {
        setAudioError(
          error instanceof Error ? error.message : "Audio recording failed.",
        );
      }
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      mediaRecorderRef.current = null;
      setIsRecordingAudio(false);
    }
  };

  const handleMessagesScroll = useCallback(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;

    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 80;
  }, []);

  const waitingForFirstToken =
    isGenerating && messages[messages.length - 1]?.role !== "assistant";
  const liveAssistantMessageId = isGenerating
    ? messages[messages.length - 1]?.role === "assistant"
      ? messages[messages.length - 1]?.id
      : undefined
    : undefined;
  const composerGenerationStatus = isGenericThinkingStatus(generationStatus)
    ? null
    : generationStatus;
  const isWebSearchActive = webSearchAvailable && webSearchEnabled;
  const isKnowledgeActive = knowledgeAvailable && knowledgeEnabled;
  const isThinkingActive = thinkingAvailable && thinkingEnabled;
  const readyAttachments = attachments.filter((a) => a.status === "ready");
  const hasLoadingAttachments = attachments.some((a) => a.status === "loading");
  const hasUserMessages = messages.some((message) => message.role === "user");
  const backendLabel = backendStatus?.connected
    ? "Connected"
    : humanizeBackendState(backendStatus?.state);
  const headerSubtitle = activeSessionTitle
    ? `Friday · ${backendLabel}`
    : backendLabel;
  const capabilityStatus = imageInputAvailable
    ? null
    : IMAGE_INPUT_UNAVAILABLE_MESSAGE;
  const webSearchStatusMessage = userFacingWebSearchStatusMessage(
    backendStatus,
    webSearchAvailable,
    isWebSearchActive,
    webSearchStatus,
  );
  const knowledgeStatusMessage = userFacingKnowledgeStatusMessage(
    knowledgeAvailable,
    isKnowledgeActive,
    knowledgeStatus,
  );

  return (
    <div
      ref={dropZoneRef}
      className="chat-pane"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="chat-drop-overlay surface-card surface-card--accent">
          <div className="chat-drop-overlay__icon">📎</div>
          <Text style={{ fontSize: 18, fontWeight: 600, color: "var(--friday-green)" }}>
            Drop files here to add to context
          </Text>
          <Text type="secondary" style={{ fontSize: 13 }}>
            Supports TXT, PDF, DOCX, audio, images, code files, and more
          </Text>
        </div>
      )}

      <div className="chat-topbar">
        <div className="chat-topbar__identity">
          <Button
            icon={<MenuOutlined />}
            onClick={onToggleSidebar}
            aria-label={isSidebarOpen ? "Hide sidebar" : "Show sidebar"}
            className="friday-icon-button"
          />
          <AppLogo size={40} />
          <div className="chat-topbar__copy">
            <Text strong className="chat-topbar__title">
              {activeSessionTitle}
            </Text>
            <Text type="secondary" className="chat-topbar__subtitle">
              {headerSubtitle}
            </Text>
          </div>
        </div>

        <div className="chat-topbar__meta">
          <Select
            size="small"
            value={replyLanguage}
            onChange={onLanguageChange}
            options={REPLY_LANGUAGE_OPTIONS}
            className="friday-compact-select"
            aria-label="Reply language"
          />
          <span className={`friday-status-pill friday-status-pill--${backendStatusTone(backendStatus)}`}>
            {backendLabel}
          </span>
          {isWebSearchActive ? (
            <span className="friday-status-pill friday-status-pill--warning">
              Web on
            </span>
          ) : null}
          {isKnowledgeActive ? (
            <span className="friday-status-pill friday-status-pill--success">
              Knowledge on
            </span>
          ) : null}
        </div>
      </div>

      <div
        ref={messagesViewportRef}
        onScroll={handleMessagesScroll}
        className="chat-thread-scroll"
      >
        <div className="chat-thread">
          {!hasUserMessages ? (
            <div className="chat-empty-state surface-card">
              <Text strong className="chat-empty-state__title">
                {userDisplayName
                  ? `Welcome back, ${userDisplayName}.`
                  : "Welcome to Friday."}
              </Text>
              <Text type="secondary" className="chat-empty-state__body">
                Ask Friday to plan work, summarize files, or explain something in
                clear language without leaving your device by default.
              </Text>
              <div className="chat-empty-state__suggestions">
                {[
                  "Help me plan today’s work.",
                  "Summarize the attached document.",
                  "Review this file and explain the key points.",
                ].map((suggestion) => (
                  <Button
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="suggestion-chip"
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              showCopyActions={message.id !== liveAssistantMessageId}
              isStreaming={message.id === liveAssistantMessageId}
            />
          ))}

          {waitingForFirstToken && (
            <div className="chat-loading">
              <div className="chat-loading__dot" />
              <Text type="secondary">
                {generationStatus ?? "Friday is thinking..."}
              </Text>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>

      <div className="chat-composer-shell">
        <div className="chat-composer surface-card">
          {attachments.length > 0 && (
            <div className="chat-composer__attachments">
              {attachments.map((att) => (
                <Tag
                  key={att.path}
                  closable={att.status !== "loading"}
                  onClose={(e) => {
                    e.preventDefault();
                    handleRemoveAttachment(att.path);
                  }}
                  closeIcon={
                    att.status === "loading" ? (
                      <LoadingOutlined style={{ fontSize: 10 }} />
                    ) : (
                      <CloseCircleFilled
                        style={{ fontSize: 12, color: "var(--friday-text-muted)" }}
                      />
                    )
                  }
                  icon={getFileIcon(att.mimeType)}
                  color={
                    att.status === "error"
                      ? "error"
                      : att.status === "loading"
                        ? "processing"
                        : "default"
                  }
                  className={`attachment-tag attachment-tag--${att.status}`}
                >
                  <span className="attachment-tag__label">
                    {att.name}
                  </span>
                  {att.sizeBytes > 0 && (
                    <span className="attachment-tag__meta">
                      {formatFileSize(att.sizeBytes)}
                      {att.status === "loading"
                        ? " · Loading"
                        : att.status === "error"
                          ? " · Failed"
                          : " · Ready"}
                    </span>
                  )}
                </Tag>
              ))}
            </div>
          )}

          <div className="chat-composer__toolbar">
            <div className="chat-composer__toggles">
            <Button
              icon={<GlobalOutlined />}
              onClick={() => onToggleWebSearch?.()}
              disabled={!webSearchAvailable}
              aria-pressed={isWebSearchActive}
              className={`composer-toggle${isWebSearchActive ? " is-active" : ""}`}
            >
              Web
            </Button>
            <Button
              icon={<DatabaseOutlined />}
              onClick={() => onToggleKnowledge?.()}
              disabled={!knowledgeAvailable}
              aria-pressed={isKnowledgeActive}
              className={`composer-toggle${isKnowledgeActive ? " is-active" : ""}`}
            >
              Knowledge
            </Button>
            <Button
              icon={<ThunderboltOutlined />}
              onClick={() => onToggleThinking?.()}
              disabled={!thinkingAvailable}
              aria-pressed={isThinkingActive}
              className={`composer-toggle${isThinkingActive ? " is-active" : ""}`}
            >
              Think
            </Button>
            <Button
              icon={<AudioOutlined />}
              onClick={() => void handleToggleRecording()}
              disabled={!audioRecordingSupported}
              aria-pressed={isRecordingAudio}
              className={`composer-toggle${isRecordingAudio ? " is-recording" : ""}`}
            >
              {isRecordingAudio ? "Recording" : "Voice"}
            </Button>
            </div>

            <div className="chat-composer__hint">
              {isGenerating ? (
                composerGenerationStatus ? (
                  <>
                    <span className="chat-loading__dot" />
                    <span>{composerGenerationStatus}</span>
                  </>
                ) : null
              ) : (
                <span>
                  {readyAttachments.length > 0
                    ? `${readyAttachments.length} item${readyAttachments.length === 1 ? "" : "s"} ready`
                    : "Shift+Enter for a new line"}
                </span>
              )}
            </div>
          </div>

          <div className="chat-composer__input-row">
            <Button
              icon={<PlusOutlined />}
              onClick={() => void handlePickFile()}
              aria-label="Attach files"
              className="friday-icon-button"
            />
            <TextArea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                attachments.length > 0
                  ? "Ask about the attached files or audio..."
                  : "Ask Friday anything..."
              }
              autoSize={{ minRows: 1, maxRows: 4 }}
              className="chat-composer__textarea"
              style={{ flex: 1 }}
            />

            {isGenerating ? (
              <Button
                icon={<StopOutlined />}
                danger
                onClick={() => void handleCancel()}
                className="chat-composer__stop"
              >
                Stop
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={() => void handleSend()}
                disabled={
                  hasLoadingAttachments ||
                  (!input.trim() && readyAttachments.length === 0)
                }
                className="primary-action chat-composer__send"
              >
                Send
              </Button>
            )}
          </div>

          <div className="chat-composer__footnotes">
            {webSearchStatusMessage ? <span>{webSearchStatusMessage}</span> : null}
            {knowledgeStatusMessage ? <span>{knowledgeStatusMessage}</span> : null}
            {capabilityStatus ? (
              <span className="is-danger">{capabilityStatus}</span>
            ) : null}
            {audioError ? <span className="is-danger">{audioError}</span> : null}
            <span className="chat-composer__footnote-hint">
              {isRecordingAudio ? "Recording…" : "Enter to send"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
