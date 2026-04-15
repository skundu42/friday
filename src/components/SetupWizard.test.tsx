import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SetupWizard from "./SetupWizard";
import type { AppSettings, SetupStatus } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const settings: AppSettings = {
  auto_start_backend: true,
  user_display_name: "Asha",
  chat: {
    reply_language: "english",
    max_tokens: 4096,
    web_assist_enabled: false,
    generation: {
      thinking_enabled: true,
    },
  },
};

const readySetupStatus: SetupStatus = {
  modelId: "gemma-4-e2b-it",
  readyToChat: true,
  modelDownloaded: true,
  modelDisplayName: "Gemma 4 E2B",
  modelSizeGb: 2.4,
  minRamGb: 4,
  totalRamGb: 16,
  meetsRamMinimum: true,
  runtimeInstalled: true,
  partialDownloadBytes: 0,
};

describe("SetupWizard", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
  });

  it("moves forward instead of returning to welcome when setup status removes steps", async () => {
    let resolveSetupStatus: ((status: SetupStatus) => void) | undefined;

    invokeMock.mockImplementation((command) => {
      if (command === "get_setup_status") {
        return new Promise<SetupStatus>((resolve) => {
          resolveSetupStatus = resolve;
        });
      }
      if (command === "warm_backend") {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    render(
      <SetupWizard
        settings={settings}
        onSaveSettings={vi.fn(async (input) => ({
          auto_start_backend: input.auto_start_backend,
          user_display_name: input.user_display_name,
          chat: input.chat,
        }))}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /let.?s get started/i }));
    expect(screen.getByText("System Check")).not.toBeNull();

    await act(async () => {
      resolveSetupStatus?.(readySetupStatus);
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /start chatting/i }),
      ).not.toBeNull(),
    );
    expect(screen.queryByText("Welcome to Friday")).toBeNull();
  });
});
