import { describe, expect, it } from "vitest";
import { friendlyError } from "./friendly-error";

describe("friendlyError", () => {
  it("maps the busy-worker error to friendly copy", () => {
    const raw =
      "A response is already in progress for this chat. Cancel it before sending another message.";
    expect(friendlyError(raw)).toContain(
      "still finishing your previous message",
    );
  });

  it("maps a warm-up error to a starting-up message", () => {
    expect(
      friendlyError("Python worker did not become ready in time."),
    ).toContain("still starting up");
  });

  it("strips a leading warning glyph before matching", () => {
    const raw =
      "⚠️ Friday web assist is not yet supported on this platform build.";
    expect(friendlyError(raw)).toBe(
      "Web search isn't available in this build of Friday.",
    );
  });

  it("passes unknown errors through unchanged", () => {
    expect(friendlyError("Some brand new error")).toBe("Some brand new error");
  });
});
