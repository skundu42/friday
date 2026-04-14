import React, {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Typography, Avatar, Card, Button } from "antd";
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
import type { Message } from "../types";
import AppLogo from "./AppLogo";

const { Text } = Typography;

// Detect file markers in enriched messages
const FILE_MARKER_RE = /^--- File: (.+) ---$/m;
const LEGACY_REFERENCE_ATTACHMENT_RE =
  /\[Reference attachment: ([^\]\n]+)\][\s\S]*?--- End extracted text from \1 ---/g;
const LEGACY_INLINE_ATTACHMENT_RE =
  /\[Attached (?:image|audio|file): ([^\]\n]+?)(?: \([^)]+\))?\]/g;
const MISPLACED_BOLD_RE = /(^|[\s([{"'`])([^\s*]+)\*\*([—:-][^\n]*?)\*\*/g;
const CLOSED_BOLD_NO_SPACE_RE =
  /(^|[\s([{"'`])(\*\*[^\s*](?:[^*\n]*?[^\s*])?\*\*)(?=[A-Za-z0-9])/g;
const BOLD_MARKER_RE = /\*\*/g;
const BOLD_INNER_WHITESPACE_RE = /\*\*([ \t]+)([^*\n][^*\n]*?)([ \t]+)?\*\*/g;
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

export function normalizeAssistantMarkdown(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      let normalized = line.replace(MISPLACED_BOLD_RE, "$1**$2$3**");
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

      const markerCount = normalized.match(BOLD_MARKER_RE)?.length ?? 0;
      if (markerCount % 2 === 1) {
        normalized = normalized.replace(/\*\*(?!.*\*\*)/, "");
      }

      return normalized;
    })
    .join("\n");
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
      style={{
        borderRadius: 8,
        width: 24,
        minWidth: 24,
        paddingInline: 0,
        height: 24,
        color: copied ? "#52C41A" : "#666",
        background: "transparent",
      }}
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
  const streamingStateRef = useRef(isStreaming);
  const rawThinkingContent = getAssistantThinking(message.content_parts);
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
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginBottom: 16,
        }}
      >
        <div
          style={{
            maxWidth: "72ch",
            display: "flex",
            gap: 10,
            flexDirection: "row-reverse",
          }}
        >
          <Avatar
            size={34}
            icon={<UserOutlined />}
            style={{
              background: "#4DABF7",
              flexShrink: 0,
              border: "2px solid #2C2C2C",
            }}
          />
          <Card
            size="small"
            style={{
              background: "#52C41A",
              color: "#FFF",
              border: "3px solid #2C2C2C",
              boxShadow: "4px 4px 0 #2C2C2C",
              borderRadius: "16px 16px 4px 16px",
            }}
            styles={{ body: { padding: "10px 14px" } }}
          >
            <Text
              style={{ color: "#FFF", whiteSpace: "pre-wrap", fontSize: 14 }}
            >
              {renderedUserContent}
            </Text>
            {(hasFileMarkers || hasAttachmentTag) && (
              <div style={{ marginTop: 6, fontSize: 11, opacity: 0.8 }}>
                📎 Files included in context
              </div>
            )}
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid={`assistant-bubble-${message.id}`}
      style={{ display: "flex", marginBottom: 16 }}
    >
      <div
        style={{
          width: "100%",
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
        }}
      >
        <div style={{ flexShrink: 0 }}>
          <AppLogo size={34} />
        </div>
        <Card
          size="small"
          style={{
            flex: 1,
            width: "100%",
            position: "relative",
            background: "#FFFFFF",
            border: "3px solid #2C2C2C",
            boxShadow: "4px 4px 0 #2C2C2C",
            borderRadius: "16px 16px 16px 4px",
          }}
          styles={{ body: { padding: "10px 16px" } }}
        >
          <Text
            type="secondary"
            style={{
              fontSize: 11,
              display: "block",
              marginBottom: 6,
              color: "#52C41A",
            }}
          >
            Friday
          </Text>
          <div
            className="markdown-body"
            style={{ fontSize: 14, lineHeight: 1.7, maxWidth: "72ch" }}
          >
            <ReactMarkdown
              remarkPlugins={MARKDOWN_REMARK_PLUGINS}
              rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
              components={markdownComponents}
            >
              {assistantContent}
            </ReactMarkdown>
          </div>
          {thinkingContent ? (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 12,
                border: "2px solid #D4B106",
                background: "#FFFBE6",
              }}
            >
              <Button
                type="text"
                size="small"
                onClick={() => setIsThinkingExpanded((current) => !current)}
                icon={isThinkingExpanded ? <UpOutlined /> : <DownOutlined />}
                style={{
                  paddingInline: 0,
                  height: "auto",
                  fontWeight: 700,
                  color: "#8C6D1F",
                }}
              >
                {isStreaming
                  ? "Reasoning (live)"
                  : isThinkingExpanded
                    ? "Hide reasoning"
                    : "Show reasoning"}
              </Button>
              {isThinkingExpanded ? (
                <div
                  className="markdown-body"
                  style={{ fontSize: 13, lineHeight: 1.6, marginTop: 8 }}
                >
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
          {showCopyActions ? (
            <div
              style={{
                position: "absolute",
                right: 10,
                top: 8,
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <CopyButton text={assistantContent} label="Copy reply" />
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}

export default memo(
  MessageBubble,
  areMessageBubblePropsEqual,
);
