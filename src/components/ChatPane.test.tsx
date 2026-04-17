import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatPane from "./ChatPane";
import type { BackendStatus, WebSearchStatus } from "../types";

const invokeMock = vi.fn();
const openMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

const backendStatus: BackendStatus = {
  backend: "LiteRtLm",
  connected: true,
  models: ["gemma-4-e2b-it.litertlm"],
  base_url: "",
  total_ram_gb: 16,
  state: "connected",
  message: "ready",
  supports_native_tools: true,
  supports_audio_input: true,
  supports_image_input: true,
  supports_video_input: false,
  supports_thinking: true,
  max_context_tokens: 131072,
  recommended_max_output_tokens: 4096,
};

const webSearchStatus: WebSearchStatus = {
  provider: "searxng",
  available: true,
  running: false,
  healthy: false,
  state: "stopped",
  message: "Local web search is installed and will start on demand.",
  base_url: "http://127.0.0.1:8091",
};

function renderChatPane(overrides: Partial<ComponentProps<typeof ChatPane>> = {}) {
  return render(
    <ChatPane
      messages={[]}
      isGenerating={false}
      activeSessionTitle="New chat"
      userDisplayName="Asha"
      replyLanguage="english"
      backendStatus={backendStatus}
      onLanguageChange={() => undefined}
      onToggleSidebar={() => undefined}
      isSidebarOpen
      onSendMessage={() => undefined}
      onCancelGeneration={() => undefined}
      webSearchAvailable
      webSearchStatus={webSearchStatus}
      knowledgeAvailable
      knowledgeStatus={{ state: "ready", message: "Knowledge is ready." }}
      thinkingAvailable
      {...overrides}
    />,
  );
}

describe("ChatPane", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
  });

  it("renders the empty state and labeled controls", () => {
    renderChatPane();

    expect(screen.getByText("Welcome back, Asha.")).not.toBeNull();
    expect(screen.getByText("New chat")).not.toBeNull();
    expect(screen.getByText("Friday · Connected")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Attach files" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Voice/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Web/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Knowledge/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Think/ })).not.toBeNull();
  });

  it("shows insufficient RAM directly in the header state", () => {
    renderChatPane({
      backendStatus: {
        ...backendStatus,
        connected: false,
        state: "insufficient_ram",
      },
    });

    expect(screen.getByText("Friday · Insufficient RAM")).not.toBeNull();
  });

  it("falls back to disconnected for unknown backend states", () => {
    renderChatPane({
      backendStatus: {
        ...backendStatus,
        connected: false,
        state: "mystery_state",
      },
    });

    expect(screen.getByText("Friday · Disconnected")).not.toBeNull();
  });

  it("shows the web status pill when web search is enabled", () => {
    renderChatPane({ webSearchEnabled: true });

    expect(screen.getByText("Web on")).not.toBeNull();
  });

  it("shows local grounding copy when Knowledge is enabled", () => {
    renderChatPane({ knowledgeEnabled: true });

    expect(
      screen.getByText("Grounding this reply against your local library."),
    ).not.toBeNull();
    expect(screen.getByText("Knowledge on")).not.toBeNull();
  });

  it("does not surface idle web-search standby copy when web search is unavailable", () => {
    renderChatPane({
      webSearchEnabled: true,
      webSearchAvailable: false,
    });

    expect(
      screen.queryByText("Local web search is installed and will start on demand."),
    ).toBeNull();
  });

  it("does not surface idle web-search standby copy when the toggle is enabled", () => {
    renderChatPane({
      webSearchEnabled: true,
      webSearchAvailable: true,
    });

    expect(
      screen.queryByText("Local web search is installed and will start on demand."),
    ).toBeNull();
  });

  it("surfaces lazy Knowledge runtime status while grounding is enabled", () => {
    renderChatPane({
      knowledgeEnabled: true,
      knowledgeStatus: {
        state: "downloading_models",
        message: "Preparing Knowledge text runtime.",
      },
    });

    expect(screen.getByText("Preparing Knowledge text runtime.")).not.toBeNull();
  });

  it("surfaces broken web search configuration directly in the composer", () => {
    renderChatPane({
      webSearchEnabled: true,
      webSearchAvailable: false,
      webSearchStatus: {
        ...webSearchStatus,
        state: "config_error",
        message: "Local SearXNG config is invalid; JSON output is disabled.",
      },
    });

    expect(
      screen.getByText("Local SearXNG config is invalid; JSON output is disabled."),
    ).not.toBeNull();
    expect(
      (screen.getByRole("button", { name: /Web/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("cleans up temp files when browser PDF ingestion fails", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "save_temp_file") {
        return Promise.resolve("/tmp/bad.pdf");
      }
      if (command === "read_file_context") {
        return Promise.reject("parse failed");
      }
      if (command === "delete_temp_file") {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const { container } = renderChatPane();

    const root = container.firstElementChild as HTMLElement;
    const pdf = new File(["bad pdf"], "bad.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(pdf, "arrayBuffer", {
      value: vi
        .fn()
        .mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer),
    });

    fireEvent.drop(root, {
      dataTransfer: {
        files: [pdf],
      },
    });

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(([command]) => command === "save_temp_file"),
      ).toBe(true),
    );

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(
          ([command, payload]) =>
            command === "delete_temp_file" && payload?.path === "/tmp/bad.pdf",
        ),
      ).toBe(true),
    );
  });

  it("blocks sending while an attachment is still loading", async () => {
    let resolveRead:
      | ((value: {
          name: string;
          mimeType: string;
          sizeBytes: number;
          content: { type: string; dataUrl: string };
        }) => void)
      | undefined;
    const onSendMessage = vi.fn();

    openMock.mockResolvedValue(["/tmp/photo.png"]);
    invokeMock.mockImplementation((command: string) => {
      if (command === "read_file_context") {
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    renderChatPane({ onSendMessage });

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(
          ([command, payload]) =>
            command === "read_file_context" && payload?.path === "/tmp/photo.png",
        ),
      ).toBe(true),
    );

    const composer = screen.getByPlaceholderText(
      "Ask about the attached files or audio...",
    );
    fireEvent.change(composer, {
      target: { value: "What is in this image?" },
    });

    const sendButton = screen.getByRole("button", { name: /send/i });
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onSendMessage).not.toHaveBeenCalled();

    resolveRead?.({
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 128,
      content: {
        type: "image",
        dataUrl: "data:image/png;base64,ZmFrZQ==",
      },
    });

    await waitFor(() =>
      expect((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("accepts image attachments returned with snake_case data_url", async () => {
    const onSendMessage = vi.fn();

    openMock.mockResolvedValue(["/tmp/photo.png"]);
    invokeMock.mockImplementation((command: string) => {
      if (command === "read_file_context") {
        return Promise.resolve({
          name: "photo.png",
          mimeType: "image/png",
          sizeBytes: 128,
          content: {
            type: "image",
            data_url: "data:image/png;base64,ZmFrZQ==",
          },
        });
      }
      return Promise.resolve(undefined);
    });

    renderChatPane({ onSendMessage });

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));

    await waitFor(() =>
      expect(
        screen.getByText("photo.png"),
      ).not.toBeNull(),
    );

    const composer = screen.getByPlaceholderText(
      "Ask about the attached files or audio...",
    );
    fireEvent.change(composer, {
      target: { value: "What is in this image?" },
    });

    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(onSendMessage).toHaveBeenCalledWith(
        "What is in this image?",
        expect.arrayContaining([
          expect.objectContaining({
            name: "photo.png",
            mimeType: "image/png",
            content: expect.objectContaining({
              dataUrl: "data:image/png;base64,ZmFrZQ==",
            }),
          }),
        ]),
      ),
    );
  });

  it("rejects image attachments when the backend reports vision as unavailable", async () => {
    openMock.mockResolvedValue(["/tmp/photo.png"]);

    renderChatPane({
      backendStatus: {
        ...backendStatus,
        supports_image_input: false,
      },
    });

    expect(
      screen.getByText(
        "Image attachments are unavailable with the current local backend.",
      ),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));

    await waitFor(() => expect(screen.getByText("photo.png")).not.toBeNull());

    expect(invokeMock).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /send/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("does not submit while IME composition is active", () => {
    const onSendMessage = vi.fn();
    renderChatPane({ onSendMessage });

    const input = screen.getByPlaceholderText("Ask Friday anything...");
    fireEvent.change(input, { target: { value: "Hello" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("does not cancel on Escape when generation is not active", () => {
    const onCancelGeneration = vi.fn();
    renderChatPane({ onCancelGeneration, isGenerating: false });

    const input = screen.getByPlaceholderText("Ask Friday anything...");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onCancelGeneration).not.toHaveBeenCalled();
  });

  it("cancels on Escape when generation is active", () => {
    const onCancelGeneration = vi.fn();
    renderChatPane({ onCancelGeneration, isGenerating: true });

    const input = screen.getByPlaceholderText("Ask Friday anything...");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onCancelGeneration).toHaveBeenCalledTimes(1);
  });

  it("hides the generic thinking hint in the composer while streaming", () => {
    renderChatPane({
      isGenerating: true,
      generationStatus: "Friday is thinking…",
      messages: [
        {
          id: "assistant-1",
          session_id: "session-1",
          role: "assistant",
          content: "Partial reply",
          created_at: "2026-04-16T10:20:00Z",
        },
      ],
    });

    expect(screen.queryByText("Friday is thinking…")).toBeNull();
  });

  it("hides web activity generation text in the composer", () => {
    renderChatPane({
      isGenerating: true,
      generationStatus: "Searching the web…",
      messages: [
        {
          id: "assistant-1",
          session_id: "session-1",
          role: "assistant",
          content: "Partial reply",
          created_at: "2026-04-16T10:20:00Z",
        },
      ],
    });

    expect(screen.queryByText("Searching the web…")).toBeNull();
  });

  it("uses the latest image capability state for dropped files after rerender", async () => {
    class FileReaderMock {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null =
        null;
      onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null =
        null;

      readAsDataURL(file: Blob) {
        this.result = `data:${file.type};base64,ZmFrZQ==`;
        this.onload?.call(this as unknown as FileReader, {} as ProgressEvent<FileReader>);
      }
    }

    const originalFileReader = globalThis.FileReader;
    vi.stubGlobal("FileReader", FileReaderMock);

    try {
      const { container, rerender } = renderChatPane({
        backendStatus: {
          ...backendStatus,
          supports_image_input: false,
        },
      });

      rerender(
        <ChatPane
          messages={[]}
          isGenerating={false}
          activeSessionTitle="New chat"
          userDisplayName="Asha"
          replyLanguage="english"
          backendStatus={backendStatus}
          onLanguageChange={() => undefined}
          onToggleSidebar={() => undefined}
          isSidebarOpen
          onSendMessage={() => undefined}
          onCancelGeneration={() => undefined}
          webSearchAvailable
          thinkingAvailable
        />,
      );

      const root = container.firstElementChild as HTMLElement;
      const image = new File(["img"], "photo.png", {
        type: "image/png",
      });

      fireEvent.drop(root, {
        dataTransfer: {
          files: [image],
        },
      });

      await waitFor(() => expect(screen.getByText("photo.png")).not.toBeNull());
      expect(
        screen.queryByText(
          "Image attachments are unavailable with the current local backend.",
        ),
      ).toBeNull();

      const composer = screen.getByPlaceholderText(
        "Ask about the attached files or audio...",
      );
      fireEvent.change(composer, {
        target: { value: "Describe this image" },
      });

      await waitFor(() =>
        expect(
          (screen.getByRole("button", { name: /send/i }) as HTMLButtonElement)
            .disabled,
        ).toBe(false),
      );
    } finally {
      vi.unstubAllGlobals();
      globalThis.FileReader = originalFileReader;
    }
  });
});
