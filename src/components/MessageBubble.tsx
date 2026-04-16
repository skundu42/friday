import React, {
  memo,
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
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { FridayRenderableMessage, KnowledgeCitation } from "../types";
import {
  getMessageAttachmentsSummary,
  getMessageReasoning,
  getMessageSources,
  getMessageText,
} from "../lib/friday-chat";
import AppLogo from "./AppLogo";

const { Text } = Typography;

// Detect file markers in enriched messages
const FILE_MARKER_RE = /^--- File: (.+) ---$/m;
const LEGACY_REFERENCE_ATTACHMENT_RE =
  /\[Reference attachment: ([^\]\n]+)\][\s\S]*?--- End extracted text from \1 ---/g;
const LEGACY_INLINE_ATTACHMENT_RE =
  /\[Attached (?:image|audio|file): ([^\]\n]+?)(?: \([^)]+\))?\]/g;
const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath];
const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex];
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const FENCED_CODE_BLOCK_RE = /((?:```|~~~)[\s\S]*?(?:```|~~~))/g;
const MALFORMED_INLINE_CODE_FENCE_RE =
  /(^|\n|[^\n`~])(```|~~~)([A-Za-z0-9_-]+)[ \t]+([^\n]+)/g;
const CODE_FENCE_TRAILING_SECTION_RE =
  /(?=\b(?:[2-9]\.?\s+[A-Z][A-Za-z]|\bThen\b|\bNext\b|\bAfter\b|\bFinally\b|\bHow\b|\bWhat\b|\bWhy\b|\bWhen\b|\bWhere\b|\bCan\b|\bCould\b|\bWould\b|\bShould\b|\bLet me know if\b|\bIf you'd like\b|\bWould you like\b))/;
const LIST_ITEM_VERB_PATTERN =
  "Answering|Providing|Generating|Helping|Explaining|Summarizing|Planning|Organizing|Writing|Creating|Debugging|Reviewing|Analyzing|Researching|Translating|Drafting|Brainstorming|Comparing|Solving|Building|Refactoring|Teaching|Implementing|Testing|Defining|Computing|Deriving|Define|Compute|Derive|Implement|Test|Validate|Check|Validating|Checking";
const LIST_ITEM_VERB_RE = new RegExp(`\\b(${LIST_ITEM_VERB_PATTERN})\\b`, "g");
const COLLAPSED_TEXT_BOUNDARY_PATTERN =
  "A|An|The|This|That|These|Those|One|He|She|They|We|I|It|As|When|While|After|Before|Then|Later|Meanwhile|Suddenly|Eventually|Soon";
const COLLAPSED_TEXT_BOUNDARY_RE = new RegExp(
  `([a-z0-9,;:)"'’\\]])(?=(?:${COLLAPSED_TEXT_BOUNDARY_PATTERN})\\b)`,
  "g",
);

interface Props {
  message: FridayRenderableMessage;
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

function repairMalformedInlineCodeFences(content: string): string {
  return content.replace(
    MALFORMED_INLINE_CODE_FENCE_RE,
    (_match, prefix: string, fence: string, language: string, inlineBody: string) => {
      const closingFenceIndex = inlineBody.indexOf(fence);
      const trailingSectionIndex =
        closingFenceIndex >= 0
          ? -1
          : inlineBody.search(CODE_FENCE_TRAILING_SECTION_RE);
      const codeBody =
        closingFenceIndex >= 0
          ? inlineBody.slice(0, closingFenceIndex).trim()
          : trailingSectionIndex >= 0
            ? inlineBody.slice(0, trailingSectionIndex).trim()
            : inlineBody.trim();
      const trailingBody =
        closingFenceIndex >= 0
          ? inlineBody.slice(closingFenceIndex + fence.length).trim()
          : trailingSectionIndex >= 0
            ? inlineBody.slice(trailingSectionIndex).trim()
            : "";

      if (!codeBody) {
        return `${prefix}${fence}${language}`;
      }

      return trailingBody
        ? `${prefix}${fence}${language}\n${codeBody}\n${fence}\n\n${trailingBody}`
        : `${prefix}${fence}${language}\n${codeBody}\n${fence}`;
    },
  );
}

function normalizeDisplayMathBlocks(content: string): string {
  return content.replace(
    /\$\$([\s\S]+?)\$\$([ \t]*[.!?])?/g,
    (_match, mathBody: string, trailingPunctuation = "", offset: number, source: string) => {
      let trailingNewlines = 0;

      for (let index = offset - 1; index >= 0 && source[index] === "\n"; index -= 1) {
        trailingNewlines += 1;
      }

      const leadingBreak =
        offset === 0 || trailingNewlines >= 2 ? "" : trailingNewlines === 1 ? "\n" : "\n\n";
      const remainingText = source.slice(offset + _match.length).trim();
      const keepTrailingPunctuation =
        trailingPunctuation.trim().length > 0 && remainingText.length > 0;

      return `${leadingBreak}$$\n${mathBody.trim()}\n$$${
        keepTrailingPunctuation ? `\n\n${trailingPunctuation.trim()}` : ""
      }`;
    },
  );
}

function normalizeMarkdownTextSegment(content: string): string {
  let normalized = content.replace(/\r\n?/g, "\n");

  normalized = normalized.replace(
    /([^\n#])(?=#{1,6}\S)/g,
    "$1\n\n",
  );
  normalized = normalized.replace(
    /([^\n`~])(?=(?:```|~~~))/g,
    "$1\n\n",
  );
  normalized = normalized.replace(
    /(^|\n)(#{1,6})(\S)/g,
    "$1$2 $3",
  );
  normalized = normalized.replace(
    /(^|\n)([-*+])(\S)/g,
    "$1$2 $3",
  );
  normalized = normalized.replace(
    /(^|\n)(\d+\.)(\S)/g,
    "$1$2 $3",
  );
  normalized = normalized.replace(
    /(#{1,6}\s+[^\n#]*?[a-z0-9\)])(?=[A-Z][a-z])/g,
    "$1\n",
  );
  normalized = normalized.replace(
    /([.?!])([A-Z])/g,
    "$1 $2",
  );
  normalized = normalized
    .split("\n")
    .flatMap((line) => {
      if (line.trimStart().startsWith("|")) {
        return [line];
      }

      const tableMatch = line.match(/^(.*?)(\|(?:[^|\n]+\|){2,})$/);
      if (!tableMatch) {
        return [line];
      }

      const prefix = tableMatch[1].trimEnd();
      const row = tableMatch[2].trim();
      return prefix ? [prefix, "", row] : [row];
    })
    .join("\n");

  LIST_ITEM_VERB_RE.lastIndex = 0;
  if (normalized.includes(":") && LIST_ITEM_VERB_RE.test(normalized)) {
    normalized = normalized.replace(
      new RegExp(`:\\s*(?=(?:${LIST_ITEM_VERB_PATTERN})\\b)`, "g"),
      ":\n\n- ",
    );
    normalized = normalized.replace(
      new RegExp(`([a-z0-9)])(?=(?:${LIST_ITEM_VERB_PATTERN})\\b)`, "g"),
      "$1\n- ",
    );
    normalized = normalized.replace(
      /([a-z0-9)])(?=(?:How|What|Why|When|Where|Can|Could|Would|Should|Do|Does|Did|Is|Are)\b)/g,
      "$1\n\n",
    );
  }

  // Compatibility repair for persisted messages created before text-part
  // boundaries were preserved during streaming. Keep this narrow: only restore
  // missing spaces on likely sentence-starter joins such as "sweepOne".
  normalized = normalized.replace(COLLAPSED_TEXT_BOUNDARY_RE, "$1 ");

  return normalized.replace(/\n{3,}/g, "\n\n");
}

export function normalizeAssistantMarkdownForDisplay(content: string): string {
  return repairMalformedInlineCodeFences(content)
    .replace(/([^\n`~])(?=(?:```|~~~))/g, "$1\n\n")
    .split(FENCED_CODE_BLOCK_RE)
    .map((segment) =>
      segment.startsWith("```") || segment.startsWith("~~~")
        ? segment
        : normalizeMarkdownTextSegment(normalizeDisplayMathBlocks(segment)),
    )
    .join("")
    .trim();
}

function extractCodeBlockMeta(
  props: React.ComponentProps<"code"> & {
    node?: {
      data?: { meta?: unknown };
      properties?: { metastring?: unknown };
      meta?: unknown;
    };
  },
): string {
  const candidates = [
    props.node?.data?.meta,
    props.node?.properties?.metastring,
    props.node?.meta,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

function normalizeExternalHref(href?: string): string | null {
  if (!href) {
    return null;
  }

  try {
    const url = new URL(href);
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
    ) {
      return url.toString();
    }
  } catch {
    return null;
  }

  return null;
}

function normalizePermittedImageSrc(src?: string): string | null {
  if (!src) {
    return null;
  }

  const trimmed = src.trim();
  if (!trimmed) {
    return null;
  }

  if (
    trimmed.startsWith("data:") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("file:") ||
    trimmed.startsWith("/")
  ) {
    return trimmed;
  }

  if (WINDOWS_ABSOLUTE_PATH_RE.test(trimmed)) {
    return trimmed;
  }

  return null;
}

async function openExternalLink(href: string) {
  try {
    await invoke("open_external_link", { url: href });
  } catch (error) {
    console.error("Failed to open link via system browser command:", error);
  }
}

function normalizeExternalHref(href?: string): string | null {
  if (!href) {
    return null;
  }

  try {
    const url = new URL(href);
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
    ) {
      return url.toString();
    }
  } catch {
    return null;
  }

  return null;
}

function normalizePermittedImageSrc(src?: string): string | null {
  if (!src) {
    return null;
  }

  const trimmed = src.trim();
  if (!trimmed) {
    return null;
  }

  if (
    trimmed.startsWith("data:") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("file:") ||
    trimmed.startsWith("/")
  ) {
    return trimmed;
  }

  if (WINDOWS_ABSOLUTE_PATH_RE.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function openExternalLink(href: string) {
  globalThis.open?.(href, "_blank", "noopener,noreferrer");
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
  meta = "",
  showCopyButton = true,
}: {
  className?: string;
  children?: React.ReactNode;
  meta?: string;
  showCopyButton?: boolean;
}) {
  const code = useMemo(
    () => {
      const childText = String(children ?? "").replace(/\n$/, "");
      return childText.trim() ? childText : meta;
    },
    [children, meta],
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
  const rawAssistantContent = getMessageText(message);
  const rawThinkingContent = getMessageReasoning(message);
  const sources = getMessageSources(message);
  const attachmentsSummary = getMessageAttachmentsSummary(message);
  const assistantContent = useMemo(
    () => normalizeAssistantMarkdownForDisplay(rawAssistantContent),
    [rawAssistantContent],
  );
  const thinkingContent = useMemo(
    () => normalizeAssistantMarkdownForDisplay(rawThinkingContent),
    [rawThinkingContent],
  );
  const markdownComponents = useMemo(
    () => ({
      code(
        props: React.ComponentProps<"code"> & {
          node?: {
            data?: { meta?: unknown };
            properties?: { metastring?: unknown };
            meta?: unknown;
          };
        },
      ) {
        const { className, children, ...rest } = props;
        const isInline = !className;
        if (isInline) {
          return (
            <code className={className} {...rest}>
              {children}
            </code>
          );
        }

        return (
          <CodeBlock
            className={className}
            meta={extractCodeBlockMeta(props)}
            showCopyButton={showCopyActions}
          >
            {children}
          </CodeBlock>
        );
      },
      a({ href, children, ...props }: React.ComponentProps<"a">) {
        const safeHref = normalizeExternalHref(href);
        if (!safeHref) {
          return <span>{children}</span>;
        }

        return (
          <a
            {...props}
            href={safeHref}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => {
              event.preventDefault();
              void openExternalLink(safeHref);
            }}
          >
            {children}
          </a>
        );
      },
      img({ src, alt, ...props }: React.ComponentProps<"img">) {
        const safeSrc = normalizePermittedImageSrc(src);
        if (!safeSrc) {
          return (
            <span className="message-card__blocked-image">
              {alt ? `Blocked remote image: ${alt}` : "Blocked remote image"}
            </span>
          );
        }

        return <img {...props} src={safeSrc} alt={alt} loading="lazy" />;
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
  const rawUserContent = getMessageText(message);
  const userContentWithAttachments =
    attachmentsSummary.length > 0 && !rawUserContent.includes("📎")
      ? `📎 ${attachmentsSummary.join(", ")}${
          rawUserContent ? `\n${rawUserContent}` : ""
        }`
      : rawUserContent;
  const renderedUserContent = isUser
    ? summarizeUserMessageForDisplay(userContentWithAttachments)
    : rawAssistantContent;
  const hasFileMarkers = FILE_MARKER_RE.test(rawUserContent);
  const hasAttachmentTag =
    attachmentsSummary.length > 0 || renderedUserContent.includes("📎");

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
                    components={markdownComponents}
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
