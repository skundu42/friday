import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPanel from "./SettingsPanel";
import type {
  AppSettings,
  AppSettingsInput,
  BackendStatus,
  ModelInfo,
} from "../types";

const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

const settings: AppSettings = {
  auto_start_backend: true,
  user_display_name: "Asha",
  theme_mode: "light",
  chat: {
    reply_language: "english",
    max_tokens: 4096,
    web_assist_enabled: false,
    knowledge_enabled: false,
    generation: {},
  },
};

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
  supports_thinking: false,
  max_context_tokens: 131072,
  recommended_max_output_tokens: 4096,
};

const activeModel: ModelInfo = {
  id: "gemma-4-e2b-it",
  repo: "litert-community/gemma-4-E2B-it-litert-lm",
  filename: "gemma-4-E2B-it.litertlm",
  display_name: "Gemma 4 E2B",
  size_bytes: 2_410_000_000,
  size_gb: 2.4,
  min_ram_gb: 4,
  supports_image_input: true,
  supports_audio_input: true,
  supports_video_input: false,
  supports_thinking: false,
  max_context_tokens: 131072,
  recommended_max_output_tokens: 4096,
};

const downloadableModel: ModelInfo = {
  id: "gemma-4-e4b-it",
  repo: "litert-community/gemma-4-E4B-it-litert-lm",
  filename: "gemma-4-E4B-it.litertlm",
  display_name: "Gemma 4 E4B",
  size_bytes: 3_400_000_000,
  size_gb: 3.4,
  min_ram_gb: 8,
  supports_image_input: true,
  supports_audio_input: true,
  supports_video_input: false,
  supports_thinking: false,
  max_context_tokens: 131072,
  recommended_max_output_tokens: 8192,
};

describe("SettingsPanel", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_models") {
        return Promise.resolve([activeModel, downloadableModel]);
      }
      if (command === "get_active_model") return Promise.resolve(activeModel);
      if (command === "list_downloaded_model_ids") {
        return Promise.resolve([activeModel.id]);
      }
      return Promise.resolve(undefined);
    });
    listenMock.mockResolvedValue(() => {});
  });

  it("renders settings content without crashing", async () => {
    render(
      <SettingsPanel
        settings={settings}
        backendStatus={backendStatus}
        activeModelId={activeModel.id}
        isSwitchingModel={false}
        onModelChange={vi.fn(async () => undefined)}
        isSaving={false}
        onSaveSettings={async (input) => ({
          auto_start_backend: input.auto_start_backend,
          user_display_name: input.user_display_name,
          theme_mode: input.theme_mode,
          chat: input.chat,
        })}
      />,
    );

    expect(screen.getByText("Settings")).not.toBeNull();
    expect(
      screen.getByRole("heading", { level: 3, name: "Conversation" }),
    ).not.toBeNull();

    await waitFor(() =>
      expect(screen.getByText("Gemma 4 E2B")).not.toBeNull(),
    );
    expect(document.body.textContent).toContain("128K context");
    expect(screen.getByText("Downloaded")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /save settings/i })).toBeNull();
    expect(screen.queryByText("Download first")).toBeNull();
  });

  it("downloads a model without switching the active selection first", async () => {
    invokeMock.mockImplementation((command: string, args?: { modelId?: string }) => {
      if (command === "list_models") {
        return Promise.resolve([activeModel, downloadableModel]);
      }
      if (command === "get_active_model") return Promise.resolve(activeModel);
      if (command === "list_downloaded_model_ids") {
        return Promise.resolve([activeModel.id]);
      }
      if (command === "pull_model") {
        return Promise.resolve(`${args?.modelId ?? "unknown"} downloaded`);
      }
      return Promise.resolve(undefined);
    });

    render(
      <SettingsPanel
        settings={settings}
        backendStatus={backendStatus}
        activeModelId={activeModel.id}
        isSwitchingModel={false}
        onModelChange={vi.fn(async () => undefined)}
        isSaving={false}
        onSaveSettings={async (input) => ({
          auto_start_backend: input.auto_start_backend,
          user_display_name: input.user_display_name,
          theme_mode: input.theme_mode,
          chat: input.chat,
        })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Gemma 4 E4B")).not.toBeNull(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /download/i })[0]);

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(
          ([command, payload]) =>
            command === "pull_model" &&
            payload?.modelId === downloadableModel.id,
        ),
      ).toBe(true),
    );
    expect(
      invokeMock.mock.calls.some(([command]) => command === "select_model"),
    ).toBe(false);
  });

  it("does not mark a model as downloaded from 100 percent progress alone", async () => {
    let downloadListener:
      | ((event: {
          payload: {
            state: string;
            displayName: string;
            downloadedBytes: number;
            totalBytes: number;
            percentage: number;
          };
        }) => void)
      | undefined;

    listenMock.mockImplementation((eventName: string, handler: typeof downloadListener) => {
      if (eventName === "model-download-progress") {
        downloadListener = handler;
      }
      return Promise.resolve(() => {});
    });

    render(
      <SettingsPanel
        settings={settings}
        backendStatus={backendStatus}
        activeModelId={activeModel.id}
        isSwitchingModel={false}
        onModelChange={vi.fn(async () => undefined)}
        isSaving={false}
        onSaveSettings={async (input) => ({
          auto_start_backend: input.auto_start_backend,
          user_display_name: input.user_display_name,
          theme_mode: input.theme_mode,
          chat: input.chat,
        })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Gemma 4 E4B")).not.toBeNull(),
    );

    fireEvent.click(screen.getAllByRole("button", { name: /download/i })[0]);

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.some(
          ([command, payload]) =>
            command === "pull_model" &&
            payload?.modelId === downloadableModel.id,
        ),
      ).toBe(true),
    );

    await act(async () => {
      downloadListener?.({
        payload: {
          state: "downloading",
          displayName: downloadableModel.display_name,
          downloadedBytes: downloadableModel.size_bytes,
          totalBytes: downloadableModel.size_bytes,
          percentage: 100,
        },
      });
    });

    expect(screen.queryAllByText("Downloaded")).toHaveLength(1);
  });

  it("preserves a custom max token value when only the reply language changes", async () => {
    const customSettings: AppSettings = {
      auto_start_backend: true,
      user_display_name: "Asha",
      theme_mode: "light",
      chat: {
        reply_language: "english",
        max_tokens: 6144,
        web_assist_enabled: false,
        knowledge_enabled: false,
        generation: {},
      },
    };
    const onSaveSettings = vi.fn(async (input: AppSettingsInput) => ({
      auto_start_backend: input.auto_start_backend,
      user_display_name: input.user_display_name,
      theme_mode: input.theme_mode,
      chat: input.chat,
    }));

    render(
      <SettingsPanel
        settings={customSettings}
        backendStatus={backendStatus}
        activeModelId={activeModel.id}
        isSwitchingModel={false}
        onModelChange={vi.fn(async () => undefined)}
        isSaving={false}
        onSaveSettings={onSaveSettings}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Current budget: 6,144 tokens (custom saved value)")).not.toBeNull(),
    );

    const replyLanguageSelectors = document.querySelectorAll(".ant-select-selector");
    fireEvent.mouseDown(replyLanguageSelectors[0]!);
    fireEvent.click(await screen.findByText("Hindi"));

    await waitFor(() => expect(onSaveSettings).toHaveBeenCalledTimes(1));
    expect(onSaveSettings.mock.calls[0]?.[0]).toEqual({
      auto_start_backend: true,
      user_display_name: "Asha",
      theme_mode: "light",
      chat: {
        reply_language: "hindi",
        max_tokens: 6144,
        web_assist_enabled: false,
        knowledge_enabled: false,
        generation: {},
      },
    });
  });

  it("persists the selected appearance mode", async () => {
    const onSaveSettings = vi.fn(async (input: AppSettingsInput) => ({
      auto_start_backend: input.auto_start_backend,
      user_display_name: input.user_display_name,
      theme_mode: input.theme_mode,
      chat: input.chat,
    }));

    render(
      <SettingsPanel
        settings={settings}
        backendStatus={backendStatus}
        activeModelId={activeModel.id}
        isSwitchingModel={false}
        onModelChange={vi.fn(async () => undefined)}
        isSaving={false}
        onSaveSettings={onSaveSettings}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

    await waitFor(() => expect(onSaveSettings).toHaveBeenCalledTimes(1));
    expect(onSaveSettings.mock.calls[0]?.[0]).toEqual({
      auto_start_backend: true,
      user_display_name: "Asha",
      theme_mode: "dark",
      chat: {
        reply_language: "english",
        max_tokens: 4096,
        web_assist_enabled: false,
        knowledge_enabled: false,
        generation: {},
      },
    });
  });

  it("uses the shared model-change callback when switching models", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_models") {
        return Promise.resolve([activeModel, downloadableModel]);
      }
      if (command === "list_downloaded_model_ids") {
        return Promise.resolve([activeModel.id, downloadableModel.id]);
      }
      return Promise.resolve(undefined);
    });

    const onModelChange = vi.fn(async () => undefined);

    render(
      <SettingsPanel
        settings={settings}
        backendStatus={backendStatus}
        activeModelId={activeModel.id}
        isSwitchingModel={false}
        onModelChange={onModelChange}
        isSaving={false}
        onSaveSettings={async (input) => ({
          auto_start_backend: input.auto_start_backend,
          user_display_name: input.user_display_name,
          theme_mode: input.theme_mode,
          chat: input.chat,
        })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /Gemma 4 E4B/i })).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("radio", { name: /Gemma 4 E4B/i }));

    await waitFor(() =>
      expect(onModelChange).toHaveBeenCalledWith(downloadableModel.id),
    );
    expect(
      invokeMock.mock.calls.some(([command]) => command === "select_model"),
    ).toBe(false);
  });
});
