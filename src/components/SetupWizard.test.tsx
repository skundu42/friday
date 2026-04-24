import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SetupWizard from "./SetupWizard";
import { APP_VERSION_LABEL } from "../lib/app-version";
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
  auto_download_updates: true,
  user_display_name: "Asha",
  theme_mode: "light",
  chat: {
    reply_language: "english",
    max_tokens: 4096,
    web_assist_enabled: false,
    knowledge_enabled: false,
    generation: {
      thinking_enabled: true,
      speculative_decoding: "auto",
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

const pendingSetupStatus: SetupStatus = {
  modelId: "gemma-4-e2b-it",
  readyToChat: false,
  modelDownloaded: false,
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
          auto_download_updates: input.auto_download_updates,
          user_display_name: input.user_display_name,
          theme_mode: input.theme_mode,
          chat: input.chat,
        }))}
        onComplete={vi.fn()}
      />,
    );

    expect(screen.getByText(APP_VERSION_LABEL)).not.toBeNull();
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

  it("shows the download stage while the local runtime is being prepared", async () => {
    let pullModelResolve: (() => void) | undefined;

    invokeMock.mockImplementation((command) => {
      if (command === "get_setup_status") {
        return Promise.resolve(pendingSetupStatus);
      }
      if (command === "pull_model") {
        return new Promise<void>((resolve) => {
          pullModelResolve = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    render(
      <SetupWizard
        settings={settings}
        onSaveSettings={vi.fn(async (input) => ({
          auto_start_backend: input.auto_start_backend,
          auto_download_updates: input.auto_download_updates,
          user_display_name: input.user_display_name,
          theme_mode: input.theme_mode,
          chat: input.chat,
        }))}
        onComplete={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("Welcome to Friday")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /let.?s get started/i }));
    fireEvent.click(screen.getByRole("button", { name: /looks good/i }));

    await waitFor(() =>
      expect(screen.getByText("Preparing Friday...")).not.toBeNull(),
    );
    expect(
      screen.getByText(/preparing the local runtime on this device/i),
    ).not.toBeNull();

    pullModelResolve?.();
  });

  it("shows retry affordances when model download fails", async () => {
    invokeMock.mockImplementation((command) => {
      if (command === "get_setup_status") {
        return Promise.resolve(pendingSetupStatus);
      }
      if (command === "pull_model") {
        return Promise.reject("Download failed");
      }
      return Promise.resolve(undefined);
    });

    render(
      <SetupWizard
        settings={settings}
        onSaveSettings={vi.fn(async (input) => ({
          auto_start_backend: input.auto_start_backend,
          auto_download_updates: input.auto_download_updates,
          user_display_name: input.user_display_name,
          theme_mode: input.theme_mode,
          chat: input.chat,
        }))}
        onComplete={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("Welcome to Friday")).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /let.?s get started/i }));
    fireEvent.click(screen.getByRole("button", { name: /looks good/i }));

    await waitFor(() =>
      expect(screen.getByText("Download failed")).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: /retry download/i })).not.toBeNull();
  });
});
