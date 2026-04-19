import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Radio,
  Select,
  Slider,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { APP_VERSION_LABEL } from "../lib/app-version";
import type {
  AppSettings,
  AppSettingsInput,
  BackendStatus,
  ModelInfo,
  ReplyLanguage,
  ThemeMode,
} from "../types";

const { Title, Text, Paragraph } = Typography;
const TOKEN_PRESETS = [1024, 4096, 8192, 16384, 32768, 65536, 131072] as const;
const TOKEN_PRESET_LABELS = [
  "1K",
  "4K",
  "8K",
  "16K",
  "32K",
  "64K",
  "128K",
] as const;
const REPLY_LANGUAGE_OPTIONS: { label: string; value: ReplyLanguage }[] = [
  { label: "English", value: "english" },
  { label: "Hindi", value: "hindi" },
  { label: "Bengali", value: "bengali" },
  { label: "Marathi", value: "marathi" },
  { label: "Tamil", value: "tamil" },
  { label: "Punjabi", value: "punjabi" },
];
function coerceMaxTokens(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 16384;
  }

  const closest = TOKEN_PRESETS.reduce((best, preset) => {
    const currentDistance = Math.abs(preset - value);
    const bestDistance = Math.abs(best - value);
    return currentDistance < bestDistance ? preset : best;
  }, TOKEN_PRESETS[0]);

  return closest;
}

function findPresetIndex(value: number) {
  const exactMatch = TOKEN_PRESETS.indexOf(
    value as (typeof TOKEN_PRESETS)[number],
  );
  return exactMatch >= 0
    ? exactMatch
    : TOKEN_PRESETS.indexOf(coerceMaxTokens(value));
}

function formatTokenCount(value: number) {
  return `${value.toLocaleString("en-IN")} tokens`;
}

function formatCompactTokenCount(value: number) {
  if (value >= 1024) {
    const compact = value / 1024;
    return `${Number.isInteger(compact) ? compact : compact.toFixed(1)}K`;
  }
  return value.toString();
}

interface SettingsPanelProps {
  settings: AppSettings;
  backendStatus: BackendStatus;
  activeModelId: string;
  isSwitchingModel: boolean;
  onModelChange: (modelId: string) => Promise<void>;
  isSaving: boolean;
  isInstallingAppUpdate: boolean;
  onSaveSettings: (input: AppSettingsInput) => Promise<AppSettings>;
}

function ModelCard({
  totalRamGb,
  activeModelId,
  isSwitchingModel,
  onModelChange,
}: {
  totalRamGb: number;
  activeModelId: string;
  isSwitchingModel: boolean;
  onModelChange: (modelId: string) => Promise<void>;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(
    null,
  );
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, number>
  >({});
  const [downloadedModelIds, setDownloadedModelIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const refreshDownloadedModels = async () => {
    const downloadedIds = await invoke<string[]>("list_downloaded_model_ids");
    setDownloadedModelIds(downloadedIds);
  };

  useEffect(() => {
    void (async () => {
      try {
        const [list, downloadedIds] = await Promise.all([
          invoke<ModelInfo[]>("list_models"),
          invoke<string[]>("list_downloaded_model_ids"),
        ]);
        setModels(list);
        setDownloadedModelIds(downloadedIds);
        setDownloadProgress(
          downloadedIds.reduce<Record<string, number>>((progress, modelId) => {
            const model = list.find((item) => item.id === modelId);
            if (model) {
              progress[model.display_name] = 100;
            }
            return progress;
          }, {}),
        );
      } catch (e) {
        console.error("Failed to load models:", e);
      }
    })();
  }, []);

  useEffect(() => {
    const unlisten = listen<{
      state: string;
      displayName: string;
      downloadedBytes: number;
      totalBytes: number;
      percentage: number;
    }>("model-download-progress", (event) => {
      const p = event.payload;
      if (p.state === "downloading") {
        setDownloadProgress((prev) => ({
          ...prev,
          [p.displayName]: p.percentage,
        }));
      } else if (p.state === "complete") {
        setDownloadProgress((prev) => ({ ...prev, [p.displayName]: 100 }));
        setDownloadingModelId(null);
        void refreshDownloadedModels();
      } else if (p.state === "error") {
        setDownloadingModelId(null);
      }
    });

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const handleSelect = async (modelId: string) => {
    if (modelId === activeModelId) return;
    if (!downloadedModelIds.includes(modelId)) {
      setError("Download the model before switching to it.");
      return;
    }
    setError(null);
    try {
      setSwitching(true);
      await onModelChange(modelId);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setSwitching(false);
    }
  };

  const handleDownload = async (modelId: string) => {
    setDownloadingModelId(modelId);
    setError(null);
    try {
      await invoke<string>("pull_model", { modelId });
      await refreshDownloadedModels();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
      setDownloadingModelId(null);
    }
  };

  return (
    <div>
      {error ? (
        <Alert
          type="error"
          message={error}
          style={{ marginBottom: 12 }}
          closable
          onClose={() => setError(null)}
        />
      ) : null}

      <Radio.Group
        value={activeModelId || undefined}
        onChange={(e) => void handleSelect(e.target.value)}
        style={{ width: "100%" }}
        disabled={Boolean(downloadingModelId) || switching || isSwitchingModel}
      >
        <Space direction="vertical" style={{ width: "100%" }} size={10} className="settings-model-list">
          {models.map((model) => {
            const isActive = model.id === activeModelId;
            const progress = downloadProgress[model.display_name];
            const ramOk = totalRamGb >= model.min_ram_gb;
            const isDownloaded = downloadedModelIds.includes(model.id);
            const isDownloading = downloadingModelId === model.id;

            return (
              <Radio
                key={model.id}
                value={model.id}
                style={{ width: "100%" }}
                className="settings-model-option"
                disabled={!isDownloaded && !isActive}
              >
                <div className={`settings-model-card${isActive ? " is-active" : ""}`}>
                  <div className="settings-model-card__header">
                    <div className="settings-model-card__content">
                      <div className="settings-model-card__title-row">
                        <strong>{model.display_name}</strong>
                        <Space size={8} wrap>
                          {isActive ? (
                            <Tag color="green" style={{ margin: 0, fontSize: 10 }}>
                              Current
                            </Tag>
                          ) : null}
                          {!ramOk ? (
                            <Tag color="warning" style={{ margin: 0, fontSize: 10 }}>
                              Low RAM
                            </Tag>
                          ) : null}
                          {progress !== undefined && progress > 0 && progress < 100 ? (
                            <Tag color="processing" style={{ margin: 0, fontSize: 10 }}>
                              {progress}%
                            </Tag>
                          ) : null}
                        </Space>
                      </div>
                      <Text type="secondary" className="settings-model-card__meta">
                        {formatCompactTokenCount(model.max_context_tokens)} context
                        {" · "}
                        {model.size_gb.toFixed(1)} GB download
                        {" · "}
                        {model.min_ram_gb} GB RAM minimum
                      </Text>
                    </div>

                    <div className="settings-model-card__actions">
                      {isDownloaded ? (
                        <Tag
                          color="success"
                          icon={<CheckCircleOutlined />}
                          style={{ margin: 0, fontSize: 11, padding: "2px 8px" }}
                        >
                          Downloaded
                        </Tag>
                      ) : (
                        <Button
                          size="small"
                          type={isActive ? "primary" : "default"}
                          icon={<DownloadOutlined />}
                          loading={isDownloading}
                          disabled={
                            (Boolean(downloadingModelId) &&
                              downloadingModelId !== model.id) ||
                            !ramOk
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDownload(model.id);
                          }}
                        >
                          Download
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </Radio>
            );
          })}
        </Space>
      </Radio.Group>
    </div>
  );
}

export default function SettingsPanel({
  settings,
  backendStatus,
  activeModelId,
  isSwitchingModel,
  onModelChange,
  isSaving,
  isInstallingAppUpdate,
  onSaveSettings,
}: SettingsPanelProps) {
  const [themeMode, setThemeMode] = useState(settings.theme_mode);
  const [autoDownloadUpdates, setAutoDownloadUpdates] = useState(
    settings.auto_download_updates,
  );
  const [replyLanguage, setReplyLanguage] = useState(
    settings.chat.reply_language,
  );
  const [maxTokens, setMaxTokens] = useState(settings.chat.max_tokens);
  const [maxTokenSliderIndex, setMaxTokenSliderIndex] = useState(
    findPresetIndex(settings.chat.max_tokens),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSavingMaxTokens, setIsSavingMaxTokens] = useState(false);
  const isCustomTokenValue = !TOKEN_PRESETS.includes(
    maxTokens as (typeof TOKEN_PRESETS)[number],
  );

  useEffect(() => {
    setThemeMode(settings.theme_mode);
    setAutoDownloadUpdates(settings.auto_download_updates);
    setReplyLanguage(settings.chat.reply_language);
    setMaxTokens(settings.chat.max_tokens);
    setMaxTokenSliderIndex(findPresetIndex(settings.chat.max_tokens));
  }, [settings]);

  const persistAutoDownloadUpdates = async (nextAutoDownloadUpdates: boolean) => {
    if (nextAutoDownloadUpdates === settings.auto_download_updates) {
      return;
    }

    const previousAutoDownloadUpdates = autoDownloadUpdates;
    setAutoDownloadUpdates(nextAutoDownloadUpdates);
    setError(null);

    try {
      await onSaveSettings({
        auto_start_backend: settings.auto_start_backend,
        auto_download_updates: nextAutoDownloadUpdates,
        user_display_name: settings.user_display_name,
        theme_mode: themeMode,
        chat: {
          reply_language: replyLanguage,
          max_tokens: settings.chat.max_tokens,
          web_assist_enabled: settings.chat.web_assist_enabled,
          knowledge_enabled: settings.chat.knowledge_enabled,
          generation: settings.chat.generation,
        },
      });
    } catch (saveError) {
      setAutoDownloadUpdates(previousAutoDownloadUpdates);
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    }
  };

  const persistReplyLanguage = async (nextReplyLanguage: ReplyLanguage) => {
    if (nextReplyLanguage === settings.chat.reply_language) {
      return;
    }

    const previousReplyLanguage = replyLanguage;
    setReplyLanguage(nextReplyLanguage);
    setError(null);

    try {
      await onSaveSettings({
        auto_start_backend: settings.auto_start_backend,
        auto_download_updates: autoDownloadUpdates,
        user_display_name: settings.user_display_name,
        theme_mode: themeMode,
        chat: {
          reply_language: nextReplyLanguage,
          max_tokens: settings.chat.max_tokens,
          web_assist_enabled: settings.chat.web_assist_enabled,
          knowledge_enabled: settings.chat.knowledge_enabled,
          generation: settings.chat.generation,
        },
      });
    } catch (saveError) {
      setReplyLanguage(previousReplyLanguage);
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    }
  };

  const persistMaxTokens = async (nextMaxTokens: number) => {
    if (nextMaxTokens === settings.chat.max_tokens) {
      return;
    }

    setError(null);
    setIsSavingMaxTokens(true);
    const persistedMaxTokens = settings.chat.max_tokens;

    try {
      await onSaveSettings({
        auto_start_backend: settings.auto_start_backend,
        auto_download_updates: autoDownloadUpdates,
        user_display_name: settings.user_display_name,
        theme_mode: themeMode,
        chat: {
          reply_language: replyLanguage,
          max_tokens: nextMaxTokens,
          web_assist_enabled: settings.chat.web_assist_enabled,
          knowledge_enabled: settings.chat.knowledge_enabled,
          generation: settings.chat.generation,
        },
      });
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
      setMaxTokens(persistedMaxTokens);
      setMaxTokenSliderIndex(findPresetIndex(persistedMaxTokens));
    } finally {
      setIsSavingMaxTokens(false);
    }
  };

  const persistThemeMode = async (nextThemeMode: ThemeMode) => {
    if (nextThemeMode === settings.theme_mode) {
      return;
    }

    const previousThemeMode = themeMode;
    setThemeMode(nextThemeMode);
    setError(null);

    try {
      await onSaveSettings({
        auto_start_backend: settings.auto_start_backend,
        auto_download_updates: autoDownloadUpdates,
        user_display_name: settings.user_display_name,
        theme_mode: nextThemeMode,
        chat: {
          reply_language: replyLanguage,
          max_tokens: settings.chat.max_tokens,
          web_assist_enabled: settings.chat.web_assist_enabled,
          knowledge_enabled: settings.chat.knowledge_enabled,
          generation: settings.chat.generation,
        },
      });
    } catch (saveError) {
      setThemeMode(previousThemeMode);
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    }
  };

  return (
    <div className="settings-panel">
      <section className="settings-hero surface-card surface-card--accent">
        <div className="settings-header settings-header--page">
          <Title level={3} className="settings-header__title">
            Settings
          </Title>
          <Paragraph className="settings-header__body">
            Tune conversation behavior, manage the local model, and choose how
            Friday looks.
          </Paragraph>
        </div>
      </section>

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={error}
        />
      ) : null}

      <div className="settings-workbench surface-card">
        <div className="settings-layout">
          <div className="settings-stack settings-stack--main">
            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h3 className="section-heading__title">Conversation</h3>
                </div>
              </div>

              <div className="settings-field">
                <Text className="settings-field__label">Reply language</Text>
                <Text className="settings-field__body">
                  Friday defaults to this language unless a prompt explicitly asks
                  for translation or quoted text in another one.
                </Text>
                <Select
                  value={replyLanguage}
                  onChange={(value) => void persistReplyLanguage(value)}
                  className="friday-compact-select"
                  style={{ width: 220, maxWidth: "100%" }}
                  options={REPLY_LANGUAGE_OPTIONS}
                  loading={isSaving}
                />
              </div>

              <div className="settings-field">
                <Text className="settings-field__label">Response budget</Text>
                <Text className="settings-field__body">
                  Higher budgets allow longer answers, but they can increase latency
                  and memory use.
                </Text>
                <div className="settings-slider-shell">
                  <Slider
                    min={0}
                    max={TOKEN_PRESETS.length - 1}
                    step={null}
                    marks={Object.fromEntries(
                      TOKEN_PRESET_LABELS.map((label, index) => [index, label]),
                    )}
                    value={maxTokenSliderIndex}
                    onChange={(value) => {
                      const nextIndex = Array.isArray(value) ? value[0] : value;
                      const nextValue = TOKEN_PRESETS[nextIndex] ?? TOKEN_PRESETS[0];
                      setMaxTokenSliderIndex(nextIndex);
                      setMaxTokens(nextValue);
                    }}
                    onChangeComplete={(value) => {
                      const nextIndex = Array.isArray(value) ? value[0] : value;
                      void persistMaxTokens(
                        TOKEN_PRESETS[nextIndex] ?? TOKEN_PRESETS[0],
                      );
                    }}
                    tooltip={{ open: false }}
                  />
                  <div className="settings-token-summary">
                    Current budget: {formatTokenCount(maxTokens)}
                    {isCustomTokenValue ? " (custom saved value)" : ""}
                    {isSaving || isSavingMaxTokens ? " · Applying..." : ""}
                  </div>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h3 className="section-heading__title">Appearance</h3>
                </div>
              </div>

              <div className="settings-appearance-control">
                <Radio.Group
                  optionType="button"
                  buttonStyle="solid"
                  value={themeMode}
                  className="settings-theme-toggle"
                  onChange={(event) =>
                    void persistThemeMode(event.target.value as ThemeMode)
                  }
                >
                  <Radio.Button value="light">Light</Radio.Button>
                  <Radio.Button value="dark">Dark</Radio.Button>
                </Radio.Group>
              </div>
            </section>
          </div>

          <div className="settings-stack settings-stack--side">
            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h3 className="section-heading__title">Model</h3>
                  <p className="section-heading__body">
                    Keep only the models you need. Switching models may restart the
                    local runtime before the next reply.
                  </p>
                </div>
              </div>

              <ModelCard
                totalRamGb={backendStatus.total_ram_gb}
                activeModelId={activeModelId}
                isSwitchingModel={isSwitchingModel}
                onModelChange={onModelChange}
              />
            </section>

            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h3 className="section-heading__title">System</h3>
                </div>
              </div>

              <div className="settings-field">
                <Text className="settings-field__label">Autodownload</Text>
                <Text className="settings-field__body">
                  Friday downloads new releases in the background and only asks
                  you to restart when the update is ready.
                  {isInstallingAppUpdate
                    ? " Downloading the latest update now."
                    : ""}
                </Text>
                <Switch
                  aria-label="Autodownload"
                  checked={autoDownloadUpdates}
                  onChange={(checked) =>
                    void persistAutoDownloadUpdates(checked)
                  }
                  loading={isSaving}
                  disabled={isSaving || isInstallingAppUpdate}
                />
              </div>

              <div className="settings-meta-grid">
                {[
                  {
                    label: "App",
                    value: APP_VERSION_LABEL,
                  },
                  {
                    label: "System RAM",
                    value: `${backendStatus.total_ram_gb.toFixed(1)} GB`,
                  },

                ].map((item) => (
                  <div key={item.label} className="settings-meta-card">
                    <Text className="settings-meta-card__label">{item.label}</Text>
                    <Text className="settings-meta-card__value">{item.value}</Text>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
