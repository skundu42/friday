import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  InputNumber,
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
import {
  REPLY_LANGUAGE_OPTIONS,
  REPLY_LANGUAGE_SELECT_PROPS,
} from "../lib/reply-languages";
import type {
  AppSettings,
  AppSettingsInput,
  BackendStatus,
  ModelInfo,
  ReplyLanguage,
  SpeculativeDecodingMode,
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
const TEMPERATURE_FALLBACK = 1.0;
const TOP_P_FALLBACK = 0.95;
const SPECULATIVE_DECODING_OPTIONS: Array<{
  label: string;
  value: SpeculativeDecodingMode;
}> = [
  { label: "Auto", value: "auto" },
  { label: "On", value: "enabled" },
  { label: "Off", value: "disabled" },
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

function formatCompactTokenCount(value: number) {
  if (value >= 1024) {
    const compact = value / 1024;
    return `${Number.isInteger(compact) ? compact : compact.toFixed(1)}K`;
  }
  return value.toString();
}

function formatModelId(value: string) {
  if (value === "gemma-4-e2b-it") return "Gemma 4 E2B";
  if (value === "gemma-4-e4b-it") return "Gemma 4 E4B";
  return value || "Not selected";
}

function formatTitleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function clampGenerationValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatGenerationValue(value: number) {
  return Number(value.toFixed(2));
}

function generationValueFromInput(
  value: number | string | null,
  fallback: number,
  min: number,
  max: number,
) {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return formatGenerationValue(clampGenerationValue(numericValue, min, max));
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

function GenerationField({
  label,
  description,
  value,
  fallbackValue,
  min,
  max,
  step,
  lowLabel,
  highLabel,
  disabled,
  loading,
  onPreview,
  onCommit,
}: {
  label: string;
  description: string;
  value: number | null | undefined;
  fallbackValue: number;
  min: number;
  max: number;
  step: number;
  lowLabel: string;
  highLabel: string;
  disabled: boolean;
  loading: boolean;
  onPreview: (value: number) => void;
  onCommit: (value: number | null) => Promise<void>;
}) {
  const effectiveValue = value ?? fallbackValue;
  const isDefault = value == null;

  return (
    <div className="settings-field settings-field--generation">
      <div className="settings-field__copy">
        <div className="settings-field__label-row">
          <Text className="settings-field__label">{label}</Text>
          {isDefault ? <Tag>Model default</Tag> : null}
        </div>
        <Text className="settings-field__body">{description}</Text>
      </div>
      <div className="settings-field__control settings-field__control--wide">
        <div className="settings-generation-control">
          <div className="settings-generation-control__inputs">
            <InputNumber
              min={min}
              max={max}
              step={step}
              value={effectiveValue}
              disabled={disabled}
              onChange={(nextValue) => {
                onPreview(
                  generationValueFromInput(nextValue, fallbackValue, min, max),
                );
              }}
              onBlur={() => void onCommit(effectiveValue)}
            />
            <Button
              size="small"
              onClick={() =>
                void onCommit(isDefault ? fallbackValue : null)
              }
              loading={loading}
              disabled={disabled}
            >
              {isDefault ? "Customize" : "Reset"}
            </Button>
          </div>
          <Slider
            min={min}
            max={max}
            step={step}
            value={effectiveValue}
            disabled={disabled}
            onChange={(nextValue) => {
              const numericValue = Array.isArray(nextValue)
                ? nextValue[0]
                : nextValue;
              onPreview(
                formatGenerationValue(
                  clampGenerationValue(numericValue, min, max),
                ),
              );
            }}
            onChangeComplete={(nextValue) => {
              const numericValue = Array.isArray(nextValue)
                ? nextValue[0]
                : nextValue;
              void onCommit(
                formatGenerationValue(
                  clampGenerationValue(numericValue, min, max),
                ),
              );
            }}
            tooltip={{ formatter: (nextValue) => nextValue?.toFixed(2) }}
          />
          <div className="settings-generation-control__scale">
            <Text>{lowLabel}</Text>
            <Text>{highLabel}</Text>
          </div>
        </div>
      </div>
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
  const [temperature, setTemperature] = useState<number | null>(
    settings.chat.generation.temperature ?? null,
  );
  const [topP, setTopP] = useState<number | null>(
    settings.chat.generation.top_p ?? null,
  );
  const [speculativeDecoding, setSpeculativeDecoding] =
    useState<SpeculativeDecodingMode>(
      settings.chat.generation.speculative_decoding,
    );
  const [maxTokenSliderIndex, setMaxTokenSliderIndex] = useState(
    findPresetIndex(settings.chat.max_tokens),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSavingMaxTokens, setIsSavingMaxTokens] = useState(false);
  const [savingGenerationControl, setSavingGenerationControl] = useState<
    "temperature" | "top_p" | null
  >(null);
  const isCustomTokenValue = !TOKEN_PRESETS.includes(
    maxTokens as (typeof TOKEN_PRESETS)[number],
  );

  useEffect(() => {
    setThemeMode(settings.theme_mode);
    setAutoDownloadUpdates(settings.auto_download_updates);
    setReplyLanguage(settings.chat.reply_language);
    setMaxTokens(settings.chat.max_tokens);
    setMaxTokenSliderIndex(findPresetIndex(settings.chat.max_tokens));
    setTemperature(settings.chat.generation.temperature ?? null);
    setTopP(settings.chat.generation.top_p ?? null);
    setSpeculativeDecoding(settings.chat.generation.speculative_decoding);
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

  const persistGenerationControl = async (
    control: "temperature" | "top_p",
    nextValue: number | null,
  ) => {
    const currentValue =
      control === "temperature"
        ? (settings.chat.generation.temperature ?? null)
        : (settings.chat.generation.top_p ?? null);
    if (Object.is(nextValue, currentValue)) {
      return;
    }

    const previousTemperature = temperature;
    const previousTopP = topP;
    if (control === "temperature") {
      setTemperature(nextValue);
    } else {
      setTopP(nextValue);
    }
    setSavingGenerationControl(control);
    setError(null);

    try {
      await onSaveSettings({
        auto_start_backend: settings.auto_start_backend,
        auto_download_updates: autoDownloadUpdates,
        user_display_name: settings.user_display_name,
        theme_mode: themeMode,
        chat: {
          reply_language: replyLanguage,
          max_tokens: settings.chat.max_tokens,
          web_assist_enabled: settings.chat.web_assist_enabled,
          knowledge_enabled: settings.chat.knowledge_enabled,
          generation: {
            ...settings.chat.generation,
            temperature:
              control === "temperature"
                ? nextValue
                : settings.chat.generation.temperature,
            top_p:
              control === "top_p" ? nextValue : settings.chat.generation.top_p,
          },
        },
      });
    } catch (saveError) {
      setTemperature(previousTemperature);
      setTopP(previousTopP);
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSavingGenerationControl(null);
    }
  };

  const persistSpeculativeDecoding = async (
    nextSpeculativeDecoding: SpeculativeDecodingMode,
  ) => {
    if (
      nextSpeculativeDecoding === settings.chat.generation.speculative_decoding
    ) {
      return;
    }

    const previousSpeculativeDecoding = speculativeDecoding;
    setSpeculativeDecoding(nextSpeculativeDecoding);
    setError(null);

    try {
      await onSaveSettings({
        auto_start_backend: settings.auto_start_backend,
        auto_download_updates: autoDownloadUpdates,
        user_display_name: settings.user_display_name,
        theme_mode: themeMode,
        chat: {
          reply_language: replyLanguage,
          max_tokens: settings.chat.max_tokens,
          web_assist_enabled: settings.chat.web_assist_enabled,
          knowledge_enabled: settings.chat.knowledge_enabled,
          generation: {
            ...settings.chat.generation,
            speculative_decoding: nextSpeculativeDecoding,
          },
        },
      });
    } catch (saveError) {
      setSpeculativeDecoding(previousSpeculativeDecoding);
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    }
  };

  return (
    <div className="settings-panel workspace-page workspace-page--settings">
      <section className="workspace-header">
        <div className="workspace-header__copy">
          <span className="workspace-header__eyebrow">Preferences</span>
          <Title level={3} className="workspace-header__title">
            Settings
          </Title>
          <Paragraph className="workspace-header__body">
            Tune conversation behavior, manage the local model, and choose how
            Friday looks.
          </Paragraph>
        </div>
      </section>

      <div className="workspace-stat-grid workspace-stat-grid--settings">
        <div className="workspace-stat">
          <span className="workspace-stat__label">Active model</span>
          <strong>{formatModelId(activeModelId)}</strong>
        </div>
        <div className="workspace-stat">
          <span className="workspace-stat__label">Reply language</span>
          <strong>{formatTitleCase(replyLanguage)}</strong>
        </div>
        <div className="workspace-stat">
          <span className="workspace-stat__label">Response budget</span>
          <strong>{formatCompactTokenCount(maxTokens)}</strong>
        </div>
        <div className="workspace-stat">
          <span className="workspace-stat__label">Theme</span>
          <strong>{formatTitleCase(themeMode)}</strong>
        </div>
      </div>

      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={error}
        />
      ) : null}

      <div className="settings-workbench workspace-board">
        <div className="settings-layout">
          <div className="settings-stack settings-stack--main">
            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h3 className="section-heading__title">Conversation</h3>
                </div>
              </div>

              <div className="settings-field">
                <div className="settings-field__copy">
                  <Text className="settings-field__label">Reply language</Text>
                  <Text className="settings-field__body">
                    Friday defaults to this language unless a prompt explicitly asks
                    for translation or quoted text in another one.
                  </Text>
                </div>
                <div className="settings-field__control">
                  <Select
                    value={replyLanguage}
                    onChange={(value) => void persistReplyLanguage(value)}
                    className="friday-compact-select"
                    style={{ width: 220, maxWidth: "100%" }}
                    options={REPLY_LANGUAGE_OPTIONS}
                    {...REPLY_LANGUAGE_SELECT_PROPS}
                    loading={isSaving}
                  />
                </div>
              </div>

              <div className="settings-field">
                <div className="settings-field__copy">
                  <Text className="settings-field__label">Response budget</Text>
                  <Text className="settings-field__body">
                    Higher budgets allow longer answers, but they can increase latency
                    and memory use.
                  </Text>
                </div>
                <div className="settings-field__control settings-field__control--wide">
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
                  </div>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h3 className="section-heading__title">Advanced</h3>
                </div>
              </div>

              <GenerationField
                label="Temperature"
                description="Lower values keep replies focused. Higher values make wording and ideas more varied."
                value={temperature}
                fallbackValue={TEMPERATURE_FALLBACK}
                min={0}
                max={2}
                step={0.05}
                lowLabel="Focused"
                highLabel="Varied"
                disabled={isSaving || savingGenerationControl !== null}
                loading={savingGenerationControl === "temperature"}
                onPreview={(nextValue) => setTemperature(nextValue)}
                onCommit={(nextValue) =>
                  persistGenerationControl("temperature", nextValue)
                }
              />

              <GenerationField
                label="Top-p"
                description="Lower values sample from a tighter token pool. Higher values leave more alternatives available."
                value={topP}
                fallbackValue={TOP_P_FALLBACK}
                min={0}
                max={1}
                step={0.01}
                lowLabel="Narrow"
                highLabel="Broad"
                disabled={isSaving || savingGenerationControl !== null}
                loading={savingGenerationControl === "top_p"}
                onPreview={(nextValue) => setTopP(nextValue)}
                onCommit={(nextValue) =>
                  persistGenerationControl("top_p", nextValue)
                }
              />

              <div className="settings-field">
                <div className="settings-field__copy">
                  <Text className="settings-field__label">
                    Speculative decoding
                  </Text>
                  <Text className="settings-field__body">
                    Auto uses the LiteRT model default. Turning it on can improve
                    decode latency on supported models.
                  </Text>
                </div>
                <div className="settings-field__control">
                  <Radio.Group
                    optionType="button"
                    buttonStyle="solid"
                    value={speculativeDecoding}
                    options={SPECULATIVE_DECODING_OPTIONS}
                    onChange={(event) =>
                      void persistSpeculativeDecoding(
                        event.target.value as SpeculativeDecodingMode,
                      )
                    }
                    disabled={isSaving}
                  />
                </div>
              </div>
            </section>

            <section className="settings-section">
              <div className="section-heading">
                <div>
                  <h3 className="section-heading__title">Appearance</h3>
                </div>
              </div>

              <div className="settings-field">
                <div className="settings-field__copy">
                  <Text className="settings-field__label">Theme</Text>
                  <Text className="settings-field__body">
                    Match the interface to your working environment.
                  </Text>
                </div>
                <div className="settings-field__control">
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
                </div>
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
                <div className="settings-field__copy">
                  <Text className="settings-field__label">Autodownload</Text>
                  <Text className="settings-field__body">
                    Friday downloads new releases in the background and only asks
                    you to restart when the update is ready.
                    {isInstallingAppUpdate
                      ? " Downloading the latest update now."
                      : ""}
                  </Text>
                </div>
                <div className="settings-field__control">
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
