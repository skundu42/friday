import { describe, expect, it } from "vitest";
import type { Session } from "../types";
import { bucketForSession, groupSessionsByDate } from "./session-buckets";

// Build an ISO timestamp `days` ago at a fixed local hour. Constructing from
// local date parts keeps the test timezone-robust (both construction and
// bucketing interpret the instant in local time).
function localDateDaysAgo(days: number, hour = 9): string {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - days,
    hour,
  ).toISOString();
}

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: "s1",
    title: "Chat",
    created_at: localDateDaysAgo(0),
    updated_at: localDateDaysAgo(0),
    pinned: false,
    ...overrides,
  };
}

describe("session-buckets", () => {
  it("buckets sessions by how recent they are", () => {
    expect(bucketForSession(localDateDaysAgo(0))).toBe("today");
    expect(bucketForSession(localDateDaysAgo(1))).toBe("yesterday");
    expect(bucketForSession(localDateDaysAgo(3))).toBe("week");
    expect(bucketForSession(localDateDaysAgo(30))).toBe("older");
  });

  it("treats an invalid date as older", () => {
    expect(bucketForSession("not-a-date")).toBe("older");
  });

  it("lifts pinned sessions into the pinned group regardless of date", () => {
    const sessions = [
      makeSession({
        id: "old-pinned",
        updated_at: localDateDaysAgo(120),
        pinned: true,
      }),
      makeSession({ id: "today-unpinned", updated_at: localDateDaysAgo(0) }),
    ];
    const grouped = groupSessionsByDate(sessions);
    expect(grouped.pinned.map((session) => session.id)).toEqual(["old-pinned"]);
    expect(grouped.today.map((session) => session.id)).toEqual([
      "today-unpinned",
    ]);
  });
});
