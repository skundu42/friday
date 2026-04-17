import type {
  FridayAssistantContentParts,
  FridayChatMessage,
  FridayMessageMetadata,
  FridayUIMessage,
  KnowledgeCitation,
  Message,
} from "../types";

const INLINE_ATTACHMENT_SUMMARY_RE = /^📎\s+(.+?)(?:\n|$)/;

type MessageWithParts = Partial<Pick<FridayChatMessage, "metadata" | "parts">> &
  Partial<Pick<Message, "content" | "content_parts">>;

function isKnowledgeCitationArray(value: unknown): value is KnowledgeCitation[] {
  return Array.isArray(value);
}

function getPersistedThinking(contentParts: unknown): string {
  if (!contentParts || typeof contentParts !== "object") {
    return "";
  }

  const thinking = (contentParts as { thinking?: unknown }).thinking;
  return typeof thinking === "string" ? thinking : "";
}

function getPersistedSources(contentParts: unknown): KnowledgeCitation[] {
  if (!contentParts || typeof contentParts !== "object") {
    return [];
  }

  const sources = (contentParts as { sources?: unknown }).sources;
  return isKnowledgeCitationArray(sources) ? sources : [];
}

export function extractInlineAttachmentSummary(content: string): string[] {
  const match = content.match(INLINE_ATTACHMENT_SUMMARY_RE);
  if (!match) {
    return [];
  }

  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getMessageText(message: MessageWithParts): string {
  const textParts =
    message.parts?.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    ) ?? [];

  if (textParts.length > 0) {
    return textParts.join("");
  }

  return typeof message.content === "string" ? message.content : "";
}

export function getMessageReasoning(message: MessageWithParts): string {
  const reasoningParts =
    message.parts?.flatMap((part) =>
      part.type === "reasoning" ? [part.text] : [],
    ) ?? [];

  if (reasoningParts.length > 0) {
    return reasoningParts.join("");
  }

  return getPersistedThinking(message.content_parts);
}

export function getMessageSources(message: MessageWithParts): KnowledgeCitation[] {
  const metadataSources = message.metadata?.sources;
  if (isKnowledgeCitationArray(metadataSources) && metadataSources.length > 0) {
    return metadataSources;
  }

  return getPersistedSources(message.content_parts);
}

export function getMessageAttachmentsSummary(message: MessageWithParts): string[] {
  const metadataAttachments = message.metadata?.attachmentsSummary;
  if (Array.isArray(metadataAttachments) && metadataAttachments.length > 0) {
    return metadataAttachments.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }

  return typeof message.content === "string"
    ? extractInlineAttachmentSummary(message.content)
    : [];
}

export function getMessageContentParts(
  message: MessageWithParts,
): FridayAssistantContentParts | null {
  const thinking = getMessageReasoning(message);
  const sources = getMessageSources(message);

  return (
    !thinking && sources.length === 0
      ? null
      : {
          ...(thinking ? { thinking } : {}),
          ...(sources.length > 0 ? { sources } : {}),
        }
  );
}

export function normalizeFridayMessage(message: FridayChatMessage): FridayUIMessage {
  const metadata: FridayMessageMetadata = {
    sessionId: message.metadata?.sessionId ?? "local-session",
    createdAt: message.metadata?.createdAt ?? new Date(0).toISOString(),
    ...(message.metadata?.modelUsed !== undefined
      ? { modelUsed: message.metadata.modelUsed }
      : {}),
    ...(message.metadata?.sources ? { sources: message.metadata.sources } : {}),
    ...(message.metadata?.attachmentsSummary
      ? { attachmentsSummary: message.metadata.attachmentsSummary }
      : {}),
  };

  return {
    ...message,
    metadata,
    session_id: metadata.sessionId,
    created_at: metadata.createdAt,
    model_used: metadata.modelUsed,
    content: getMessageText(message),
    content_parts: getMessageContentParts(message),
  };
}

export function normalizeFridayMessages(
  messages: FridayChatMessage[],
): FridayUIMessage[] {
  return messages.map(normalizeFridayMessage);
}

export function toFridayChatMessage(message: Message): FridayChatMessage {
  const thinking = getPersistedThinking(message.content_parts);
  const sources = getPersistedSources(message.content_parts);
  const attachmentsSummary =
    message.role === "user" ? extractInlineAttachmentSummary(message.content) : [];

  return {
    id: message.id,
    role: message.role,
    metadata: {
      sessionId: message.session_id,
      createdAt: message.created_at,
      modelUsed: message.model_used ?? undefined,
      ...(sources.length > 0 ? { sources } : {}),
      ...(attachmentsSummary.length > 0 ? { attachmentsSummary } : {}),
    },
    parts: [
      ...(message.content
        ? [{ type: "text" as const, text: message.content, state: "done" as const }]
        : []),
      ...(message.role === "assistant" && thinking
        ? [
            {
              type: "reasoning" as const,
              text: thinking,
              state: "done" as const,
            },
          ]
        : []),
    ],
  };
}

export function toFridayChatMessages(messages: Message[]): FridayChatMessage[] {
  return messages.map(toFridayChatMessage);
}

export function makeFridayAssistantMessage({
  id,
  sessionId,
  content,
  createdAt = new Date().toISOString(),
  modelUsed,
  thinking,
  sources,
}: {
  id: string;
  sessionId: string;
  content: string;
  createdAt?: string;
  modelUsed?: string | null;
  thinking?: string;
  sources?: KnowledgeCitation[];
}): FridayChatMessage {
  return {
    id,
    role: "assistant",
    metadata: {
      sessionId,
      createdAt,
      ...(modelUsed !== undefined ? { modelUsed } : {}),
      ...(sources && sources.length > 0 ? { sources } : {}),
    },
    parts: [
      ...(content
        ? [{ type: "text" as const, text: content, state: "done" as const }]
        : []),
      ...(thinking
        ? [
            {
              type: "reasoning" as const,
              text: thinking,
              state: "done" as const,
            },
          ]
        : []),
    ],
  };
}
