import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MessageBubble, {
  areMessageBubblePropsEqual,
  normalizeAssistantMarkdown,
} from "./MessageBubble";

describe("normalizeAssistantMarkdown", () => {
  it("moves misplaced bold markers to wrap the intended phrase", () => {
    expect(
      normalizeAssistantMarkdown(
        "Circles is unaligned**—free from any single nation, corporation, geopolitical bloc influence**",
      ),
    ).toBe(
      "Circles is **unaligned—free from any single nation, corporation, geopolitical bloc influence**",
    );
  });

  it("inserts a missing space after a closed bold span", () => {
    expect(normalizeAssistantMarkdown("**Trust**Mechanism:**")).toBe(
      "**Trust** Mechanism:",
    );
  });

  it("does not corrupt later bold spans on the same line when fixing spacing", () => {
    expect(
      normalizeAssistantMarkdown(
        "This document is a certificate for Sandipan Kundu, associated with the ID ** NISM20250000312171**, dated ** November 18, 2025**.",
      ),
    ).toBe(
      "This document is a certificate for Sandipan Kundu, associated with the ID **NISM20250000312171**, dated **November 18, 2025**.",
    );
  });

  it("trims stray whitespace inside bold markers", () => {
    expect(
      normalizeAssistantMarkdown(
        "Current Conditions: The temperature is ** 22.1°C** with rain.",
      ),
    ).toBe("Current Conditions: The temperature is **22.1°C** with rain.");
  });

  it("removes a dangling unmatched bold marker on a line", () => {
    expect(
      normalizeAssistantMarkdown(
        "**Problem with fiat money: issuance is centralized, leading to exploitation and control.",
      ),
    ).toBe(
      "Problem with fiat money: issuance is centralized, leading to exploitation and control.",
    );
  });
});

describe("MessageBubble", () => {
  it("shows copy actions without requiring hover when the reply is complete", () => {
    render(
      <MessageBubble
        message={{
          id: "m1",
          role: "assistant",
          content: "```ts\nconsole.log('hi')\n```",
        }}
      />,
    );

    expect(screen.getByLabelText("Copy reply")).not.toBeNull();
    expect(screen.getByLabelText("Copy code")).not.toBeNull();
  });

  it("keeps copy actions hidden while an assistant response is still streaming", () => {
    render(
      <MessageBubble
        message={{
          id: "m2",
          role: "assistant",
          content: "```ts\nconsole.log('hi')\n```",
        }}
        showCopyActions={false}
      />,
    );

    expect(screen.queryByLabelText("Copy reply")).toBeNull();
    expect(screen.queryByLabelText("Copy code")).toBeNull();
  });

  it("renders the answer before reasoning and keeps reasoning collapsed by default", () => {
    render(
      <MessageBubble
        message={{
          id: "m3",
          role: "assistant",
          content: "Final answer",
          content_parts: { thinking: "Step 1\nStep 2" },
        }}
      />,
    );

    expect(screen.getByText("Final answer")).not.toBeNull();
    expect(screen.getByRole("button", { name: /show reasoning/i })).not.toBeNull();
    expect(screen.queryByText("Step 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /show reasoning/i }));
    expect(screen.getByText(/Step 1\s*Step 2/)).not.toBeNull();
  });

  it("keeps reasoning expanded while the response is streaming", () => {
    render(
      <MessageBubble
        message={{
          id: "m4",
          role: "assistant",
          content: "Partial answer",
          content_parts: { thinking: "Live reasoning" },
        }}
        isStreaming
        showCopyActions={false}
      />,
    );

    expect(screen.getByRole("button", { name: /reasoning \(live\)/i })).not.toBeNull();
    expect(screen.getByText("Live reasoning")).not.toBeNull();
  });

  it("treats unchanged completed bubbles as memo-stable while streamed content changes are not", () => {
    expect(
      areMessageBubblePropsEqual(
        {
          message: {
            id: "stable",
            role: "assistant",
            content: "Finished answer",
          },
          showCopyActions: true,
        },
        {
          message: {
            id: "stable",
            role: "assistant",
            content: "Finished answer",
          },
          showCopyActions: true,
        },
      ),
    ).toBe(true);

    expect(
      areMessageBubblePropsEqual(
        {
          message: {
            id: "live",
            role: "assistant",
            content: "Part 1",
          },
          showCopyActions: false,
        },
        {
          message: {
            id: "live",
            role: "assistant",
            content: "Part 1 Part 2",
          },
          showCopyActions: false,
        },
      ),
    ).toBe(false);

    expect(
      areMessageBubblePropsEqual(
        {
          message: {
            id: "live",
            role: "assistant",
            content: "Part 1",
          },
          showCopyActions: false,
          isStreaming: true,
        },
        {
          message: {
            id: "live",
            role: "assistant",
            content: "Part 1",
          },
          showCopyActions: false,
          isStreaming: false,
        },
      ),
    ).toBe(false);
  });
});
