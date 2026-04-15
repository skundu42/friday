import React, {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Typography, Avatar, Button } from "antd";
import {
  UserOutlined,
  CopyOutlined,
  CheckOutlined,
  DownOutlined,
  UpOutlined,
} from "@ant-design/icons";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { KnowledgeCitation, Message } from "../types";
import AppLogo from "./AppLogo";

const { Text } = Typography;

// Detect file markers in enriched messages
const FILE_MARKER_RE = /^--- File: (.+) ---$/m;
const LEGACY_REFERENCE_ATTACHMENT_RE =
  /\[Reference attachment: ([^\]\n]+)\][\s\S]*?--- End extracted text from \1 ---/g;
const LEGACY_INLINE_ATTACHMENT_RE =
  /\[Attached (?:image|audio|file): ([^\]\n]+?)(?: \([^)]+\))?\]/g;
const MISPLACED_BOLD_RE = /(^|[\s([{"'`])([^\s*]+)\*\*([—:-][^\n]*?)\*\*/g;
const OPENING_BOLD_SPAN_NO_SPACE_RE =
  /([A-Za-z0-9])(\*\*[^\s*](?:[^*\n]*?[^\s*])?\*\*)/g;
const CLOSED_BOLD_NO_SPACE_RE =
  /(^|[\s([{"'`])(\*\*[^\s*](?:[^*\n]*?[^\s*])?\*\*)(?=[A-Za-z0-9])/g;
const BOLD_MARKER_RE = /\*\*/g;
const BOLD_INNER_WHITESPACE_RE = /\*\*([ \t]+)([^*\n][^*\n]*?)([ \t]+)?\*\*/g;
const EMPTY_LIST_ITEM_RE = /^\s*[*-]\s*$/;
const BROKEN_BOLD_LABEL_LIST_ITEM_RE = /^(\s*[*-]\s+)\*\*([^*\n]+?:)\s*(.+)$/;
const ATX_HEADING_NO_SPACE_RE = /^(#{1,6})(?=\S)/;
const ORDERED_LIST_MARKER_NO_SPACE_RE = /^(\s*\d+\.)(?=\S)/;
const PLAIN_SECTION_HEADING_RE =
  /^([A-Z][A-Za-z0-9/&()'" -]{1,80}:)$/;
const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath];
const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex];

interface Props {
  message: Pick<Message, "id" | "role" | "content" | "content_parts">;
  showCopyActions?: boolean;
  isStreaming?: boolean;
}

export function areMessageBubblePropsEqual(previous: Props, next: Props) {
  return (
    previous.showCopyActions === next.showCopyActions &&
    previous.isStreaming === next.isStreaming &&
    previous.message.id === next.message.id &&
    previous.message.role === next.message.role &&
    previous.message.content === next.message.content &&
    previous.message.content_parts === next.message.content_parts
  );
}

function getAssistantThinking(contentParts: unknown): string {
  if (!contentParts || typeof contentParts !== "object") {
    return "";
  }

  const thinking = (contentParts as { thinking?: unknown }).thinking;
  return typeof thinking === "string" ? thinking : "";
}

function getAssistantSources(contentParts: unknown): KnowledgeCitation[] {
  if (!contentParts || typeof contentParts !== "object") {
    return [];
  }

  const sources = (contentParts as { sources?: unknown }).sources;
  return Array.isArray(sources) ? (sources as KnowledgeCitation[]) : [];
}

export function summarizeUserMessageForDisplay(content: string): string {
  const attachmentNames: string[] = [];
  let normalized = content;

  normalized = normalized.replace(
    LEGACY_REFERENCE_ATTACHMENT_RE,
    (_match, name: string) => {
      attachmentNames.push(name.trim());
      return "";
    },
  );
  normalized = normalized.replace(
    LEGACY_INLINE_ATTACHMENT_RE,
    (_match, name: string) => {
      attachmentNames.push(name.trim());
      return "";
    },
  );

  const remaining = normalized.replace(/\n{3,}/g, "\n\n").trim();
  if (attachmentNames.length === 0) {
    return content;
  }

  const attachmentTag = `📎 ${Array.from(new Set(attachmentNames)).join(", ")}`;
  return remaining ? `${attachmentTag}\n${remaining}` : attachmentTag;
}

function isSingleCharacterFragment(text: string): boolean {
  return /^[A-Za-z0-9≤≥=+\-−×÷/().,%]$/.test(text);
}

function collapseFragmentedMarkdownLines(lines: string[]): string[] {
  const collapsed: string[] = [];
  let insideCodeFence = false;

  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    if (line.trimStart().startsWith("```")) {
      insideCodeFence = !insideCodeFence;
      collapsed.push(line);
      index += 1;
      continue;
    }

    if (insideCodeFence) {
      collapsed.push(line);
      index += 1;
      continue;
    }

    const currentTrimmed = line.trim();
    const nextTrimmed = lines[index + 1]?.trim() ?? "";
    const nextNextTrimmed = lines[index + 2]?.trim() ?? "";

    if (
      /^[≤≥=+\-−]$/.test(currentTrimmed) &&
      /^[A-Za-z0-9.,]{1,8}$/.test(nextTrimmed) &&
      nextNextTrimmed.startsWith(`${currentTrimmed}${nextTrimmed}`)
    ) {
      index += 2;
      continue;
    }

    if (isSingleCharacterFragment(currentTrimmed)) {
      let runEnd = index;
      let merged = "";
      while (
        runEnd < lines.length &&
        isSingleCharacterFragment(lines[runEnd]?.trim() ?? "")
      ) {
        merged += lines[runEnd]!.trim();
        runEnd += 1;
      }

      if (runEnd - index >= 4) {
        const followingTrimmed = lines[runEnd]?.trim() ?? "";
        if (!followingTrimmed.startsWith(merged)) {
          collapsed.push(merged);
        }
        index = runEnd;
        continue;
      }
    }

    collapsed.push(line);
    index += 1;
  }

  return collapsed;
}

export function normalizeAssistantMarkdown(content: string): string {
  let insideCodeFence = false;
  const normalizedLines = collapseFragmentedMarkdownLines(content.split("\n"))
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        insideCodeFence = !insideCodeFence;
        return line;
      }
      if (insideCodeFence) {
        return line;
      }

      let normalized = line.replace(MISPLACED_BOLD_RE, "$1**$2$3**");
      normalized = normalized.replace(ATX_HEADING_NO_SPACE_RE, "$1 ");
      normalized = normalized.replace(
        ORDERED_LIST_MARKER_NO_SPACE_RE,
        "$1 ",
      );
      normalized = normalized.replace(
        BOLD_INNER_WHITESPACE_RE,
        (_match, _leadingWhitespace, text) => {
          const cleaned = String(text).trim();
          if (!cleaned) {
            return "";
          }
          return `**${cleaned}**`;
        },
      );

      normalized = normalized.replace(CLOSED_BOLD_NO_SPACE_RE, "$1$2 ");
      normalized = normalized.replace(OPENING_BOLD_SPAN_NO_SPACE_RE, "$1 $2");
      normalized = normalized.replace(CLOSED_BOLD_NO_SPACE_RE, "$1$2 ");
      normalized = normalized.replace(
        BROKEN_BOLD_LABEL_LIST_ITEM_RE,
        "$1**$2** $3",
      );

      const markerCount = normalized.match(BOLD_MARKER_RE)?.length ?? 0;
      if (markerCount % 2 === 1) {
        normalized = normalized.replace(/\*\*(?!.*\*\*)/, "");
      }

      if (EMPTY_LIST_ITEM_RE.test(normalized)) {
        return "";
      }

      const trimmed = normalized.trim();
      if (
        trimmed &&
        !trimmed.startsWith("**") &&
        !trimmed.startsWith("#") &&
        !trimmed.startsWith("* ") &&
        !trimmed.startsWith("- ") &&
        PLAIN_SECTION_HEADING_RE.test(trimmed)
      ) {
        return `**${trimmed}**`;
      }

      return normalized;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  return normalizedLines;
}

function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        setCopied(false);
      }, 1500);
    } catch (error) {
      console.error("Copy failed:", error);
    }
  };

  return (
    <Button
      size="small"
      icon={copied ? <CheckOutlined /> : <CopyOutlined />}
      onClick={() => void handleCopy()}
      type="text"
      className="copy-button"
      style={copied ? { color: "var(--friday-green)" } : undefined}
      aria-label={copied ? `${label} copied` : label}
      title={copied ? "Copied" : label}
    />
  );
}

function CodeBlock({
  className,
  children,
  showCopyButton = true,
}: {
  className?: string;
  children?: React.ReactNode;
  showCopyButton?: boolean;
}) {
  const code = useMemo(
    () => String(children ?? "").replace(/\n$/, ""),
    [children],
  );

  return (
    <div className="code-block-shell">
      <div className="code-block-toolbar">
        <Text type="secondary" style={{ fontSize: 11 }}>
          {className?.replace(/^language-/, "") || "code"}
        </Text>
        {showCopyButton && <CopyButton text={code} label="Copy code" />}
      </div>
      <pre>
        <code className={className}>{code}</code>
      </pre>
    </div>
  );
}

function MessageBubble({
  message,
  showCopyActions = true,
  isStreaming = false,
}: Props) {
  const isUser = message.role === "user";
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(isStreaming);
  const [isSourcesExpanded, setIsSourcesExpanded] = useState(false);
  const streamingStateRef = useRef(isStreaming);
  const rawThinkingContent = getAssistantThinking(message.content_parts);
  const sources = getAssistantSources(message.content_parts);
  const deferredAssistantSource = useDeferredValue(
    isStreaming ? message.content : "",
  );
  const deferredThinkingSource = useDeferredValue(
    isStreaming ? rawThinkingContent : "",
  );
  const assistantSource = isStreaming ? deferredAssistantSource : message.content;
  const thinkingSource = isStreaming ? deferredThinkingSource : rawThinkingContent;
  const assistantContent = useMemo(
    () => normalizeAssistantMarkdown(assistantSource),
    [assistantSource],
  );
  const thinkingContent = useMemo(
    () => normalizeAssistantMarkdown(thinkingSource),
    [thinkingSource],
  );
  const markdownComponents = useMemo(
    () => ({
      code({ className, children, ...props }: React.ComponentProps<"code">) {
        const isInline = !className;
        if (isInline) {
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        }

        return (
          <CodeBlock className={className} showCopyButton={showCopyActions}>
            {children}
          </CodeBlock>
        );
      },
    }),
    [showCopyActions],
  );

  useEffect(() => {
    if (!thinkingContent) {
      streamingStateRef.current = isStreaming;
      return;
    }

    if (isStreaming) {
      setIsThinkingExpanded(true);
    } else if (streamingStateRef.current && !isStreaming) {
      setIsThinkingExpanded(false);
    }

    streamingStateRef.current = isStreaming;
  }, [isStreaming, thinkingContent]);

  // Detect attached file indicators in user messages
  const renderedUserContent = isUser
    ? summarizeUserMessageForDisplay(message.content)
    : message.content;
  const hasFileMarkers = FILE_MARKER_RE.test(message.content);
  const hasAttachmentTag = renderedUserContent.includes("📎");

  if (isUser) {
    return (
      <div className="message-row message-row--user">
        <div className="message-row__inner">
          <div className="message-avatar message-avatar--user">
            <Avatar size={38} icon={<UserOutlined />} />
          </div>
          <div className="message-card message-card--user">
            <Text className="message-card__user-text">{renderedUserContent}</Text>
            {(hasFileMarkers || hasAttachmentTag) && (
              <div className="message-card__attachment-note">
                Files included in context
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid={`assistant-bubble-${message.id}`} className="message-row">
      <div className="message-row__inner">
        <div className="message-avatar">
          <AppLogo size={34} />
        </div>
        <div className="message-card message-card--assistant">
          <Text type="secondary" className="message-card__eyebrow">
            Friday
          </Text>
          <div className="markdown-body message-card__body">
            <ReactMarkdown
              remarkPlugins={MARKDOWN_REMARK_PLUGINS}
              rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
              components={markdownComponents}
            >
              {assistantContent}
            </ReactMarkdown>
          </div>
          {thinkingContent ? (
            <div className="message-reasoning">
              <Button
                type="text"
                size="small"
                onClick={() => setIsThinkingExpanded((current) => !current)}
                icon={isThinkingExpanded ? <UpOutlined /> : <DownOutlined />}
                className="message-reasoning__toggle"
              >
                {isStreaming
                  ? "Reasoning (live)"
                  : isThinkingExpanded
                    ? "Hide reasoning"
                    : "Show reasoning"}
              </Button>
              {isThinkingExpanded ? (
                <div className="markdown-body message-reasoning__body">
                  <ReactMarkdown
                    remarkPlugins={MARKDOWN_REMARK_PLUGINS}
                    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                  >
                    {thinkingContent}
                  </ReactMarkdown>
                </div>
              ) : null}
            </div>
          ) : null}
          {sources.length > 0 ? (
            <div className="message-sources">
              <Button
                type="text"
                size="small"
                onClick={() => setIsSourcesExpanded((current) => !current)}
                icon={isSourcesExpanded ? <UpOutlined /> : <DownOutlined />}
                className="message-sources__toggle"
              >
                {isSourcesExpanded ? "Hide sources" : `Show sources (${sources.length})`}
              </Button>
              {isSourcesExpanded ? (
                <div className="message-sources__body">
                  {sources.map((source, index) => (
                    <div
                      key={`${source.sourceId}-${source.chunkIndex ?? index}`}
                      className="message-source-item"
                    >
                      <div className="message-source-item__head">
                        <Text strong>{source.displayName}</Text>
                        <Text type="secondary">
                          {source.modality}
                          {Number.isFinite(source.score)
                            ? ` · ${source.score.toFixed(2)}`
                            : ""}
                        </Text>
                      </div>
                      <Text type="secondary" className="message-source-item__locator">
                        {source.locator}
                      </Text>
                      {source.snippet ? (
                        <div className="message-source-item__snippet">
                          {source.snippet}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {showCopyActions ? (
            <div className="message-card__copy">
              <CopyButton text={assistantContent} label="Copy reply" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default memo(
  MessageBubble,
  areMessageBubblePropsEqual,
);
