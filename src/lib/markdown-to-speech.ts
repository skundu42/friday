// Converts assistant Markdown into plain text suitable for text-to-speech.
// Code blocks and formulas are replaced with short spoken placeholders so the
// synthesizer doesn't read them character-by-character.

const FENCED_CODE_BLOCK_RE = /(?:```|~~~)[\s\S]*?(?:```|~~~)/g;
const BLOCK_MATH_RE = /\$\$[\s\S]*?\$\$/g;
const INLINE_MATH_RE = /\$[^$\n]+\$/g;
const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const HEADING_RE = /^#{1,6}\s+/gm;
const BLOCKQUOTE_RE = /^>\s?/gm;
const UNORDERED_LIST_RE = /^\s*[-*+]\s+/gm;
const ORDERED_LIST_RE = /^\s*\d+\.\s+/gm;
const EMPHASIS_RE = /(\*\*|\*|__|_|~~)/g;
const ATTACHMENT_TAG_RE = /^\s*📎.*$/gm;
const WARNING_PREFIX_RE = /^\s*⚠️\s*/u;
const EXCESS_NEWLINES_RE = /\n{3,}/g;
const EXCESS_SPACES_RE = /[ \t]{2,}/g;

export function markdownToSpeech(markdown: string): string {
  if (!markdown) return "";

  let text = markdown;
  text = text.replace(ATTACHMENT_TAG_RE, " ");
  text = text.replace(WARNING_PREFIX_RE, "");
  text = text.replace(FENCED_CODE_BLOCK_RE, ". (code block omitted). ");
  text = text.replace(BLOCK_MATH_RE, ". (formula). ");
  text = text.replace(INLINE_MATH_RE, " (formula) ");
  text = text.replace(IMAGE_RE, (_match, alt: string) => alt ?? "");
  text = text.replace(LINK_RE, (_match, label: string) => label);
  text = text.replace(INLINE_CODE_RE, (_match, code: string) => code);
  text = text.replace(HEADING_RE, "");
  text = text.replace(BLOCKQUOTE_RE, "");
  text = text.replace(UNORDERED_LIST_RE, "");
  text = text.replace(ORDERED_LIST_RE, "");
  text = text.replace(EMPHASIS_RE, "");
  text = text.replace(EXCESS_NEWLINES_RE, "\n\n");
  text = text.replace(EXCESS_SPACES_RE, " ");

  return text.trim();
}
