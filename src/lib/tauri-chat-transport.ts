import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ChatTransport, UIMessageChunk } from "ai";
import type {
  ChatDonePayload,
  ChatErrorPayload,
  ChatTokenPayload,
  FridayAssistantContentParts,
  FridayChatMessage,
  FridayMessageMetadata,
} from "../types";
import { extractInlineAttachmentSummary, getMessageText } from "./friday-chat";

type TauriInvoke = typeof invoke;
type TauriListen = typeof listen;

interface SerializedAttachmentContent {
  text?: string;
  dataUrl?: string;
  path?: string;
}

interface SerializedAttachment {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  content?: SerializedAttachmentContent | null;
}

interface FridayTransportBody {
  attachments?: SerializedAttachment[] | null;
  thinkingEnabled?: boolean;
  webAssistEnabled?: boolean;
  knowledgeEnabled?: boolean;
}

function makeId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
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

function getDoneContentParts(
  value: unknown,
): FridayAssistantContentParts | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const thinking =
    typeof (value as { thinking?: unknown }).thinking === "string"
      ? ((value as { thinking?: string }).thinking ?? "")
      : "";
  const sources = Array.isArray((value as { sources?: unknown }).sources)
    ? ((value as { sources?: FridayAssistantContentParts["sources"] }).sources ??
      [])
    : [];

  if (!thinking && sources.length === 0) {
    return undefined;
  }

  return {
    ...(thinking ? { thinking } : {}),
    ...(sources.length > 0 ? { sources } : {}),
  };
}

function getRequestMessage(
  messages: FridayChatMessage[],
  messageId?: string,
): FridayChatMessage | undefined {
  const startIndex =
    typeof messageId === "string"
      ? messages.findIndex((message) => message.id === messageId)
      : messages.length - 1;

  for (let index = startIndex; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return messages[index];
    }
  }

  return undefined;
}

function getRequestMessageText(message: FridayChatMessage): string {
  const text = getMessageText(message);
  const attachmentsSummary =
    message.metadata?.attachmentsSummary ?? extractInlineAttachmentSummary(text);

  if (attachmentsSummary.length === 0) {
    return text;
  }

  return text.replace(/^📎\s+.+?(?:\n|$)/, "").trimStart();
}

function isFridayTransportBody(body: object | undefined): body is FridayTransportBody {
  return typeof body === "object" && body !== null;
}

export class TauriChatTransport
  implements ChatTransport<FridayChatMessage>
{
  private readonly invokeFn: TauriInvoke;
  private readonly listenFn: TauriListen;
  private readonly generateId: () => string;

  constructor({
    invokeFn = invoke,
    listenFn = listen,
    generateId = makeId,
  }: {
    invokeFn?: TauriInvoke;
    listenFn?: TauriListen;
    generateId?: () => string;
  } = {}) {
    this.invokeFn = invokeFn;
    this.listenFn = listenFn;
    this.generateId = generateId;
  }

  reconnectToStream = async () => null;

  sendMessages = async ({
    chatId,
    messages,
    messageId,
    body,
    abortSignal,
  }: {
    trigger: "submit-message" | "regenerate-message";
    chatId: string;
    messageId: string | undefined;
    messages: FridayChatMessage[];
    abortSignal: AbortSignal | undefined;
    body?: object;
    headers?: Record<string, string> | Headers;
    metadata?: unknown;
  }): Promise<ReadableStream<UIMessageChunk<FridayMessageMetadata>>> => {
    const requestMessage = getRequestMessage(messages, messageId);
    if (!requestMessage) {
      throw new Error("Could not find the user message for this request.");
    }

    const requestBody = isFridayTransportBody(body) ? body : {};
    const sessionId = requestMessage.metadata?.sessionId ?? chatId;
    const assistantMessageId = this.generateId();
    const createdAt = new Date().toISOString();
    const textPartId = `${assistantMessageId}:text`;
    const reasoningPartId = `${assistantMessageId}:reasoning`;
    const requestText = getRequestMessageText(requestMessage);

    return new ReadableStream<UIMessageChunk<FridayMessageMetadata>>({
      start: async (streamController) => {
        const cleanupFns: Array<() => void> = [];
        let isClosed = false;
        let startEmitted = false;
        let textStarted = false;
        let textEnded = false;
        let reasoningStarted = false;
        let reasoningEnded = false;
        let currentMetadata: FridayMessageMetadata = {
          sessionId,
          createdAt,
        };

        const cleanup = () => {
          if (cleanupFns.length === 0) {
            return;
          }

          cleanupFns.splice(0).forEach((dispose) => dispose());
        };

        const closeStream = () => {
          if (isClosed) {
            return;
          }

          isClosed = true;
          cleanup();
          streamController.close();
        };

        const emitMetadata = (metadata: Partial<FridayMessageMetadata>) => {
          if (isClosed || Object.keys(metadata).length === 0) {
            return;
          }

          if (!startEmitted) {
            streamController.enqueue({
              type: "start",
              messageId: assistantMessageId,
              messageMetadata: { ...currentMetadata, ...metadata },
            });
            currentMetadata = { ...currentMetadata, ...metadata };
            startEmitted = true;
            return;
          }

          currentMetadata = { ...currentMetadata, ...metadata };
          streamController.enqueue({
            type: "message-metadata",
            messageMetadata: currentMetadata,
          });
        };

        const emitStart = () => {
          if (isClosed || startEmitted) {
            return;
          }

          streamController.enqueue({
            type: "start",
            messageId: assistantMessageId,
            messageMetadata: currentMetadata,
          });
          startEmitted = true;
        };

        const emitTextDelta = (delta: string) => {
          if (!delta || isClosed) {
            return;
          }

          emitStart();
          if (!textStarted) {
            streamController.enqueue({ type: "text-start", id: textPartId });
            textStarted = true;
          }

          streamController.enqueue({
            type: "text-delta",
            id: textPartId,
            delta,
          });
        };

        const emitReasoningDelta = (delta: string) => {
          if (!delta || isClosed) {
            return;
          }

          emitStart();
          if (!reasoningStarted) {
            streamController.enqueue({
              type: "reasoning-start",
              id: reasoningPartId,
            });
            reasoningStarted = true;
          }

          streamController.enqueue({
            type: "reasoning-delta",
            id: reasoningPartId,
            delta,
          });
        };

        const endText = () => {
          if (!textStarted || textEnded || isClosed) {
            return;
          }

          textEnded = true;
          streamController.enqueue({ type: "text-end", id: textPartId });
        };

        const endReasoning = () => {
          if (!reasoningStarted || reasoningEnded || isClosed) {
            return;
          }

          reasoningEnded = true;
          streamController.enqueue({ type: "reasoning-end", id: reasoningPartId });
        };

        const finishStream = (payload?: ChatDonePayload) => {
          if (isClosed) {
            return;
          }

          const contentParts = getDoneContentParts(payload?.contentParts);

          if (!textStarted && typeof payload?.content === "string" && payload.content) {
            emitTextDelta(payload.content);
          }

          if (!reasoningStarted && contentParts?.thinking) {
            emitReasoningDelta(contentParts.thinking);
          }

          const hasRenderableContent = textStarted || reasoningStarted;

          if (!hasRenderableContent) {
            closeStream();
            return;
          }

          endText();
          endReasoning();

          emitMetadata({
            ...(payload?.model ? { modelUsed: payload.model } : {}),
            ...(contentParts?.sources && contentParts.sources.length > 0
              ? { sources: contentParts.sources }
              : {}),
          });

          if (startEmitted) {
            streamController.enqueue({ type: "finish" });
          }

          closeStream();
        };

        const failStream = (message: string) => {
          if (isClosed) {
            return;
          }

          streamController.enqueue({ type: "error", errorText: message });
          closeStream();
        };

        const isCurrentSessionEvent = (eventSessionId?: string | null) =>
          typeof eventSessionId === "string" && eventSessionId === sessionId;

        const handleAbort = () => {
          closeStream();
        };

        if (abortSignal) {
          abortSignal.addEventListener("abort", handleAbort);
          cleanupFns.push(() => abortSignal.removeEventListener("abort", handleAbort));
        }

        const [
          unlistenToken,
          unlistenDone,
          unlistenError,
        ] = await Promise.all([
          this.listenFn<ChatTokenPayload>("chat-token", (event) => {
            if (!isCurrentSessionEvent(event.payload.sessionId) || isClosed) {
              return;
            }

            if (event.payload.kind === "thought") {
              emitReasoningDelta(event.payload.token);
            } else {
              emitTextDelta(event.payload.token);
            }
          }),
          this.listenFn<ChatDonePayload>("chat-done", (event) => {
            if (!isCurrentSessionEvent(event.payload.sessionId) || isClosed) {
              return;
            }

            finishStream(event.payload);
          }),
          this.listenFn<string | ChatErrorPayload>("chat-error", (event) => {
            const payload = normalizeChatErrorPayload(event.payload);
            if (!isCurrentSessionEvent(payload.sessionId) || isClosed) {
              return;
            }

            failStream(payload.message);
          }),
        ]);

        cleanupFns.push(unlistenToken, unlistenDone, unlistenError);

        void this.invokeFn("send_message", {
          request: {
            sessionId,
            message: requestText,
            attachments: requestBody.attachments ?? null,
            thinkingEnabled: Boolean(requestBody.thinkingEnabled),
            webAssistEnabled: Boolean(requestBody.webAssistEnabled),
            knowledgeEnabled: Boolean(requestBody.knowledgeEnabled),
          },
        }).catch((error) => {
          failStream(toErrorMessage(error));
        });
      },
    });
  };
}
