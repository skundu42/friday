// Maps raw backend error strings to friendlier, user-facing copy. Unknown
// errors pass through unchanged so nothing is ever silently swallowed.

interface ErrorRule {
  match: string[];
  message: string;
}

const RULES: ErrorRule[] = [
  {
    match: ["already in progress", "already handling another request"],
    message:
      "Friday is still finishing your previous message. Wait for it to complete (or stop it) and try again.",
  },
  {
    match: [
      "did not become ready",
      "failed before warm-up",
      "warm-up channel closed",
      "bootstrap warmup failed",
    ],
    message:
      "The local model is still starting up. Give it a few seconds and try again.",
  },
  {
    match: ["web assist is not yet supported"],
    message: "Web search isn't available in this build of Friday.",
  },
  {
    match: [
      "could not start local web search",
      "timed out while connecting to local web search",
      "timed out while downloading local web search",
    ],
    message:
      "Friday couldn't start local web search. You can turn Web off and try again.",
  },
  {
    match: [
      "knowledge storage is unavailable",
      "knowledge database is unavailable",
      "knowledge image runtime is unavailable",
      "knowledge text runtime is unavailable",
      "knowledge search timed out",
    ],
    message:
      "Your knowledge library is unavailable right now. Try turning Knowledge off, or reopen Friday.",
  },
  {
    match: ["database writer is unavailable", "database is unavailable"],
    message:
      "Friday couldn't reach its local storage. Reopening the app usually fixes this.",
  },
];

export function friendlyError(raw: string): string {
  if (!raw) return raw;
  const stripped = raw.replace(/^\s*⚠️\s*/u, "");
  const haystack = stripped.toLowerCase();
  for (const rule of RULES) {
    if (rule.match.some((needle) => haystack.includes(needle))) {
      return rule.message;
    }
  }
  return stripped;
}
