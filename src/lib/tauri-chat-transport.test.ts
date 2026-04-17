import { describe, expect, it, vi } from "vitest";
import { TauriChatTransport } from "./tauri-chat-transport";
import type { FridayChatMessage } from "../types";

function makeUserMessage(): FridayChatMessage {
  return {
    id: "user-1",
    role: "user",
    metadata: {
      sessionId: "session-a",
      createdAt: "2026-04-16T05:10:00Z",
    },
    parts: [{ type: "text", text: "Explain the result." }],
  };
}

function createEventBus() {
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();

  return {
    emit(eventName: string, payload: unknown) {
      listeners.get(eventName)?.forEach((listener) => listener({ payload }));
    },
    listen(eventName: string, callback: (event: { payload: unknown }) => void) {
      const handlers = listeners.get(eventName) ?? new Set();
      handlers.add(callback);
      listeners.set(eventName, handlers);

      return Promise.resolve(() => {
        handlers.delete(callback);
      });
    },
  };
}

async function readAllChunks<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader();
  const chunks: T[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value as T);
  }

  return chunks;
}

describe("TauriChatTransport", () => {
  it("streams text and reasoning into AI SDK UI message chunks", async () => {
    const bus = createEventBus();
    const invokeFn = vi.fn(() => Promise.resolve(undefined));
    const transport = new TauriChatTransport({
      invokeFn: invokeFn as never,
      listenFn: bus.listen as never,
      generateId: () => "assistant-1",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "session-a",
      messageId: undefined,
      messages: [makeUserMessage()],
      abortSignal: undefined,
      body: {},
    });

    const chunksPromise = readAllChunks(stream);

    bus.emit("chat-token", {
      sessionId: "session-a",
      token: "Hello",
      kind: "answer",
    });
    bus.emit("chat-token", {
      sessionId: "session-a",
      token: "Think first",
      kind: "thought",
    });
    bus.emit("chat-done", {
      sessionId: "session-a",
      model: "gemma-4-e2b-it",
      hasContent: true,
      content: "Hello",
      contentParts: {
        thinking: "Think first",
        sources: [
          {
            sourceId: "src-1",
            modality: "text",
            displayName: "guide.md",
            locator: "/guide.md",
            score: 0.88,
          },
        ],
      },
    });

    const chunks = await chunksPromise;

    expect(chunks).toEqual([
      {
        type: "start",
        messageId: "assistant-1",
        messageMetadata: {
          sessionId: "session-a",
          createdAt: expect.any(String),
        },
      },
      { type: "text-start", id: "assistant-1:text" },
      { type: "text-delta", id: "assistant-1:text", delta: "Hello" },
      { type: "reasoning-start", id: "assistant-1:reasoning" },
      {
        type: "reasoning-delta",
        id: "assistant-1:reasoning",
        delta: "Think first",
      },
      { type: "text-end", id: "assistant-1:text" },
      { type: "reasoning-end", id: "assistant-1:reasoning" },
      {
        type: "message-metadata",
        messageMetadata: {
          sessionId: "session-a",
          createdAt: expect.any(String),
          modelUsed: "gemma-4-e2b-it",
          sources: [
            {
              sourceId: "src-1",
              modality: "text",
              displayName: "guide.md",
              locator: "/guide.md",
              score: 0.88,
            },
          ],
        },
      },
      { type: "finish" },
    ]);
    expect(invokeFn).toHaveBeenCalledWith("send_message", {
      request: {
        sessionId: "session-a",
        message: "Explain the result.",
        attachments: null,
        thinkingEnabled: false,
        webAssistEnabled: false,
        knowledgeEnabled: false,
      },
    });
  });

  it("falls back to the authoritative chat-done payload and ignores late tokens", async () => {
    const bus = createEventBus();
    const transport = new TauriChatTransport({
      invokeFn: vi.fn(() => Promise.resolve(undefined)) as never,
      listenFn: bus.listen as never,
      generateId: () => "assistant-2",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "session-a",
      messageId: undefined,
      messages: [makeUserMessage()],
      abortSignal: undefined,
      body: {},
    });

    const chunksPromise = readAllChunks(stream);

    bus.emit("chat-done", {
      sessionId: "session-a",
      model: "gemma-4-e4b-it",
      hasContent: true,
      content: "Final answer",
      contentParts: null,
    });
    bus.emit("chat-token", {
      sessionId: "session-a",
      token: "ignored",
      kind: "answer",
    });

    const chunks = await chunksPromise;

    expect(chunks).toEqual([
      {
        type: "start",
        messageId: "assistant-2",
        messageMetadata: {
          sessionId: "session-a",
          createdAt: expect.any(String),
        },
      },
      { type: "text-start", id: "assistant-2:text" },
      { type: "text-delta", id: "assistant-2:text", delta: "Final answer" },
      { type: "text-end", id: "assistant-2:text" },
      {
        type: "message-metadata",
        messageMetadata: {
          sessionId: "session-a",
          createdAt: expect.any(String),
          modelUsed: "gemma-4-e4b-it",
        },
      },
      { type: "finish" },
    ]);
  });

  it("appends missing final text from the authoritative chat-done payload", async () => {
    const bus = createEventBus();
    const transport = new TauriChatTransport({
      invokeFn: vi.fn(() => Promise.resolve(undefined)) as never,
      listenFn: bus.listen as never,
      generateId: () => "assistant-3",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "session-a",
      messageId: undefined,
      messages: [makeUserMessage()],
      abortSignal: undefined,
      body: {},
    });

    const chunksPromise = readAllChunks(stream);

    bus.emit("chat-token", {
      sessionId: "session-a",
      token: "Hello",
      kind: "answer",
    });
    bus.emit("chat-done", {
      sessionId: "session-a",
      model: "gemma-4-e2b-it",
      hasContent: true,
      content: "Hello world",
      contentParts: null,
    });

    const chunks = await chunksPromise;

    expect(chunks).toEqual([
      {
        type: "start",
        messageId: "assistant-3",
        messageMetadata: {
          sessionId: "session-a",
          createdAt: expect.any(String),
        },
      },
      { type: "text-start", id: "assistant-3:text" },
      { type: "text-delta", id: "assistant-3:text", delta: "Hello" },
      { type: "text-delta", id: "assistant-3:text", delta: " world" },
      { type: "text-end", id: "assistant-3:text" },
      {
        type: "message-metadata",
        messageMetadata: {
          sessionId: "session-a",
          createdAt: expect.any(String),
          modelUsed: "gemma-4-e2b-it",
        },
      },
      { type: "finish" },
    ]);
  });
});
