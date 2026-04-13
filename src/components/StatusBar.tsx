import { Select, Tag, Typography } from "antd";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
} from "@ant-design/icons";
import type { BackendStatus, ModelInfo, ReplyLanguage } from "../types";

const { Text } = Typography;

interface StatusBarProps {
  backendStatus: BackendStatus | null;
  activeModelId: string;
  models: ModelInfo[];
  isBusy: boolean;
  isSwitchingModel: boolean;
  replyLanguage: ReplyLanguage;
  onModelChange: (modelId: string) => void;
  onLanguageChange: (lang: ReplyLanguage) => void;
}

const REPLY_LANGUAGE_OPTIONS: { label: string; value: ReplyLanguage }[] = [
  { label: "English", value: "english" },
  { label: "Hindi", value: "hindi" },
  { label: "Bengali", value: "bengali" },
  { label: "Marathi", value: "marathi" },
  { label: "Tamil", value: "tamil" },
  { label: "Punjabi", value: "punjabi" },
];

export default function StatusBar({
  backendStatus,
  activeModelId,
  models,
  isBusy,
  isSwitchingModel,
  replyLanguage,
  onModelChange,
  onLanguageChange,
}: StatusBarProps) {
  const connected = backendStatus?.connected ?? false;
  const ready = backendStatus?.state === "ready";
  const statusLabel = connected
    ? "Connected"
    : humanizeBackendState(backendStatus?.state);
  const statusMessage = connected
    ? null
    : humanizeBackendMessage(backendStatus?.state);
  const pillStyle = {
    margin: 0,
    height: 32,
    display: "inline-flex",
    alignItems: "center",
    paddingInline: 10,
    border: "2px solid #2C2C2C",
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 12,
    lineHeight: "16px",
  } as const;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "8px 24px",
        borderTop: "3px solid #2C2C2C",
        background: "#FFFFFF",
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          minHeight: 32,
          flexWrap: "wrap",
        }}
      >
        <Select
          size="small"
          className="status-bar-select"
          value={activeModelId || undefined}
          onChange={onModelChange}
          options={models.map((model) => ({
            label: model.display_name,
            value: model.id,
          }))}
          style={{ width: 160 }}
          disabled={isBusy || isSwitchingModel || models.length <= 1}
          placeholder="Select model"
        />

        <Select
          size="small"
          className="status-bar-select"
          value={replyLanguage}
          onChange={onLanguageChange}
          options={REPLY_LANGUAGE_OPTIONS}
          style={{ width: 132 }}
        />
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minHeight: 32,
        }}
      >
        {connected ? (
          <Tag icon={<CheckCircleOutlined />} color="success" style={pillStyle}>
            {statusLabel}
          </Tag>
        ) : ready ? (
          <Tag icon={<ClockCircleOutlined />} color="processing" style={pillStyle}>
            {statusLabel}
          </Tag>
        ) : (
          <Tag icon={<CloseCircleOutlined />} color="error" style={pillStyle}>
            {statusLabel}
          </Tag>
        )}
        {statusMessage ? (
          <Text
            type="secondary"
            style={{
              fontSize: 11,
              maxWidth: 280,
              minHeight: 32,
              display: "inline-flex",
              alignItems: "center",
            }}
            ellipsis={{ tooltip: statusMessage }}
          >
            {statusMessage}
          </Text>
        ) : null}
      </div>
    </div>
  );
}

function humanizeBackendState(state?: string) {
  switch (state) {
    case "ready":
      return "Ready";
    case "runtime_missing":
      return "Setup required";
    case "model_missing":
      return "Model missing";
    case "start_failed":
      return "Unavailable";
    default:
      return "Disconnected";
  }
}

function humanizeBackendMessage(state?: string) {
  switch (state) {
    case "ready":
      return null;
    case "runtime_missing":
      return "Complete setup to prepare the bundled LiteRT runtime.";
    case "model_missing":
      return "Complete setup to download the selected local model.";
    case "start_failed":
      return "Friday could not start the selected model.";
    default:
      return "Checking local setup…";
  }
}
