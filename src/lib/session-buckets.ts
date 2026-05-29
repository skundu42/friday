import type { Session } from "../types";

export type SessionBucket =
  | "pinned"
  | "today"
  | "yesterday"
  | "week"
  | "older";

export const BUCKET_LABELS: Record<SessionBucket, string> = {
  pinned: "Pinned",
  today: "Today",
  yesterday: "Yesterday",
  week: "Last 7 days",
  older: "Older",
};

export const BUCKET_ORDER: SessionBucket[] = [
  "pinned",
  "today",
  "yesterday",
  "week",
  "older",
];

export function bucketForSession(value: string): SessionBucket {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "older";

  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfTarget = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfTarget.getTime()) / (24 * 60 * 60 * 1000),
  );

  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return "week";
  return "older";
}

/**
 * Groups sessions for the sidebar. Pinned sessions are lifted into a single
 * "pinned" group regardless of date; the rest fall into date buckets. Input
 * order is preserved within each group, so callers should pass sessions
 * already ordered (the backend returns `pinned DESC, updated_at DESC`).
 */
export function groupSessionsByDate(
  sessions: Session[],
): Record<SessionBucket, Session[]> {
  const groups: Record<SessionBucket, Session[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    week: [],
    older: [],
  };
  for (const session of sessions) {
    if (session.pinned) {
      groups.pinned.push(session);
    } else {
      groups[bucketForSession(session.updated_at)].push(session);
    }
  }
  return groups;
}
