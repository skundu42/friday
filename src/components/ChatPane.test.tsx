import type { ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatPane from "./ChatPane";
import type { BackendStatus } from "../types";

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

  it("renders the empty state, labeled controls, and local-first trust copy", () => {
    renderChatPane();

    expect(screen.getByText("Welcome back, Asha.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Attach files" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Voice/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Web/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Think/ })).not.toBeNull();
    expect(screen.getByText("On-device only for this message")).not.toBeNull();
  });

  it("updates the trust copy when web search is enabled", () => {
    renderChatPane({ webSearchEnabled: true });

    expect(
      screen.getByText(
        "Web enabled for this message; Friday may contact external sites",
      ),
    ).not.toBeNull();
  });

  it("keeps the trust copy on-device when web search is saved but unavailable", () => {
    renderChatPane({
      webSearchEnabled: true,
      webSearchAvailable: false,
    });

    expect(screen.getByText("On-device only for this message")).not.toBeNull();
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
