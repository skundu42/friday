import { describe, expect, it } from "vitest";
import { normalizeFridayMessage, toFridayChatMessage } from "./friday-chat";
import type { Message } from "../types";

describe("friday-chat adapters", () => {
  it("converts persisted assistant messages into text and reasoning parts", () => {
    const persisted: Message = {
      id: "assistant-1",
      session_id: "session-a",
      role: "assistant",
      content: "Here is the answer.",
      content_parts: {
        thinking: "Step 1\nStep 2",
        sources: [
          {
            sourceId: "src-1",
            modality: "text",
            displayName: "notes.md",
            locator: "/notes.md",
            score: 0.92,
            snippet: "Useful supporting evidence.",
          },
        ],
      },
      model_used: "gemma-4-e2b-it",
      created_at: "2026-04-16T05:00:00Z",
    };

    const message = toFridayChatMessage(persisted);

    expect(message.metadata).toEqual({
      sessionId: "session-a",
      createdAt: "2026-04-16T05:00:00Z",
      modelUsed: "gemma-4-e2b-it",
      sources: [
        {
          sourceId: "src-1",
          modality: "text",
          displayName: "notes.md",
          locator: "/notes.md",
          score: 0.92,
          snippet: "Useful supporting evidence.",
        },
      ],
    });
    expect(message.parts).toEqual([
      { type: "text", text: "Here is the answer.", state: "done" },
      { type: "reasoning", text: "Step 1\nStep 2", state: "done" },
    ]);
  });

  it("normalizes AI SDK messages back into the UI compatibility shape", () => {
    const normalized = normalizeFridayMessage({
      id: "assistant-2",
      role: "assistant",
      metadata: {
        sessionId: "session-a",
        createdAt: "2026-04-16T05:01:00Z",
        modelUsed: "gemma-4-e4b-it",
        sources: [
          {
            sourceId: "src-2",
            modality: "text",
            displayName: "guide.md",
            locator: "/guide.md",
            score: 0.88,
          },
        ],
      },
      parts: [
        { type: "text", text: "Streaming text", state: "done" },
        { type: "reasoning", text: "Live reasoning", state: "done" },
      ],
    });

    expect(normalized.content).toBe("Streaming text");
    expect(normalized.content_parts).toEqual({
      thinking: "Live reasoning",
      sources: [
        {
          sourceId: "src-2",
          modality: "text",
          displayName: "guide.md",
          locator: "/guide.md",
          score: 0.88,
        },
      ],
    });
    expect(normalized.session_id).toBe("session-a");
    expect(normalized.created_at).toBe("2026-04-16T05:01:00Z");
    expect(normalized.model_used).toBe("gemma-4-e4b-it");
  });

  it("recomputes content parts when a streamed message object is mutated", () => {
    const sourceMessage = {
      id: "assistant-cache",
      role: "assistant" as const,
      metadata: {
        sessionId: "session-a",
        createdAt: "2026-04-16T05:03:00Z",
        sources: [
          {
            sourceId: "src-cache",
            modality: "text" as const,
            displayName: "cache.md",
            locator: "/cache.md",
            score: 0.91,
          },
        ],
      },
      parts: [
        { type: "text" as const, text: "Answer", state: "done" as const },
        { type: "reasoning" as const, text: "Thought", state: "done" as const },
      ],
    };

    const first = normalizeFridayMessage(sourceMessage);
    sourceMessage.parts = [
      { type: "text" as const, text: "Answer", state: "done" as const },
      {
        type: "reasoning" as const,
        text: "Updated thought",
        state: "done" as const,
      },
    ];
    const second = normalizeFridayMessage(sourceMessage);

    expect(first.content_parts).not.toBeNull();
    expect(first.content_parts).not.toEqual(second.content_parts);
    expect(second.content_parts).toEqual({
      thinking: "Updated thought",
      sources: [
        {
          sourceId: "src-cache",
          modality: "text",
          displayName: "cache.md",
          locator: "/cache.md",
          score: 0.91,
        },
      ],
    });
  });

  it("derives attachment summaries from persisted user display text", () => {
    const normalized = normalizeFridayMessage(
      toFridayChatMessage({
        id: "user-1",
        session_id: "session-a",
        role: "user",
        content: "📎 photo.png, notes.pdf\nPlease summarize both.",
        created_at: "2026-04-16T05:02:00Z",
      }),
    );

    expect(normalized.metadata?.attachmentsSummary).toEqual([
      "photo.png",
      "notes.pdf",
    ]);
    expect(normalized.content).toBe(
      "📎 photo.png, notes.pdf\nPlease summarize both.",
    );
  });
});
