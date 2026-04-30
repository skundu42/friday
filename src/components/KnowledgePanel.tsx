import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  List,
  Progress,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import {
  AudioOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  FileAddOutlined,
  FileImageOutlined,
  FileTextOutlined,
  GlobalOutlined,
  LinkOutlined,
  LoadingOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  KnowledgeIngestProgress,
  KnowledgeIngestStage,
  KnowledgeSource,
  KnowledgeStats,
  KnowledgeStatus,
} from "../types";

const { Paragraph, Text, Title } = Typography;

interface KnowledgePanelProps {
  status: KnowledgeStatus | null;
  sources: KnowledgeSource[];
  stats: KnowledgeStats | null;
  ingestProgress: KnowledgeIngestProgress[];
  onRefresh: () => Promise<void> | void;
  onIngestFile: (filePath: string) => Promise<void> | void;
  onIngestUrl: (url: string) => Promise<void> | void;
  onDeleteSource: (sourceId: string) => Promise<void> | void;
}

function toneForStatus(status: KnowledgeStatus | null) {
  switch (status?.state) {
    case "ready":
      return "success";
    case "needs_models":
    case "downloading_models":
    case "indexing":
      return "info";
    case "error":
      return "error";
    default:
      return "warning";
  }
}

function labelForModality(modality: KnowledgeSource["modality"]) {
  switch (modality) {
    case "webpage":
      return "Web";
    case "audio":
      return "Audio";
    case "image":
      return "Image";
    default:
      return "Text";
  }
}

function iconForSource(source: KnowledgeSource) {
  switch (source.modality) {
    case "webpage":
      return <GlobalOutlined />;
    case "audio":
      return <AudioOutlined />;
    case "image":
      return <FileImageOutlined />;
    default:
      return <FileTextOutlined />;
  }
}

function labelForStage(stage: KnowledgeIngestStage) {
  switch (stage) {
    case "indexing":
      return "Indexing";
    case "embedding":
      return "Embedding";
    case "complete":
      return "Complete";
    case "error":
      return "Failed";
    default:
      return stage;
  }
}

function progressForStage(stage: KnowledgeIngestStage) {
  switch (stage) {
    case "indexing":
      return 35;
    case "embedding":
      return 72;
    case "complete":
    case "error":
      return 100;
    default:
      return 0;
  }
}

function toneForStage(stage: KnowledgeIngestStage) {
  switch (stage) {
    case "complete":
      return "success";
    case "error":
      return "error";
    default:
      return "processing";
  }
}

function iconForStage(stage: KnowledgeIngestStage) {
  switch (stage) {
    case "complete":
      return <CheckCircleOutlined />;
    case "error":
      return <CloseCircleOutlined />;
    default:
      return <LoadingOutlined />;
  }
}

function displayNameForProgress(item: KnowledgeIngestProgress) {
  if (item.locator.startsWith("http://") || item.locator.startsWith("https://")) {
    return item.locator;
  }

  const parts = item.locator.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? item.locator;
}

function formatProgressTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export default function KnowledgePanel({
  status,
  sources,
  stats,
  ingestProgress,
  onRefresh,
  onIngestFile,
  onIngestUrl,
  onDeleteSource,
}: KnowledgePanelProps) {
  const [url, setUrl] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSubmittingUrl, setIsSubmittingUrl] = useState(false);
  const [isPickingFiles, setIsPickingFiles] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null);

  const isBusy =
    status?.state === "downloading_models" ||
    status?.state === "indexing" ||
    isSubmittingUrl ||
    isPickingFiles ||
    isRefreshing ||
    deletingSourceId !== null;

  const summaryStats = useMemo(
    () => [
      { label: "Sources", value: stats?.totalSources ?? sources.length },
      { label: "Ready", value: stats?.readySources ?? 0 },
      { label: "Text chunks", value: stats?.totalTextChunks ?? 0 },
      { label: "Images", value: stats?.totalImageAssets ?? 0 },
    ],
    [sources.length, stats],
  );

  const handleRefresh = async () => {
    setActionError(null);
    setIsRefreshing(true);
    try {
      await onRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRefreshing(false);
    }
  };

  const handlePickFiles = async () => {
    setActionError(null);
    setIsPickingFiles(true);
    try {
      const selected = await open({
        multiple: true,
      });

      if (!selected) {
        return;
      }

      const filePaths = Array.isArray(selected) ? selected : [selected];
      await Promise.all(filePaths.map((filePath) => onIngestFile(filePath)));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsPickingFiles(false);
    }
  };

  const handleSubmitUrl = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      return;
    }

    setActionError(null);
    setIsSubmittingUrl(true);
    try {
      await onIngestUrl(trimmedUrl);
      setUrl("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmittingUrl(false);
    }
  };

  const handleDeleteSource = async (sourceId: string, displayName: string) => {
    if (!window.confirm(`Delete "${displayName}" from Knowledge?`)) {
      return;
    }

    setActionError(null);
    setDeletingSourceId(sourceId);
    try {
      await onDeleteSource(sourceId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingSourceId(null);
    }
  };

  return (
    <div className="knowledge-panel workspace-page workspace-page--knowledge">
      <section className="workspace-header">
        <div className="workspace-header__copy">
          <span className="workspace-header__eyebrow">Grounding library</span>
          <Title level={3} className="workspace-header__title">
            Knowledge
          </Title>
          <Paragraph className="workspace-header__body">
            Build a local library that Friday can use to ground replies
            against your files and explicitly added URLs.
          </Paragraph>
        </div>

        <div className="workspace-header__actions">
          <span
            className={`knowledge-status-badge knowledge-status-badge--${toneForStatus(status)}`}
          >
            {status?.message ?? "Knowledge status is unavailable."}
          </span>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void handleRefresh()}
            loading={isRefreshing}
            className="secondary-action"
          >
            Refresh
          </Button>
        </div>
      </section>

      <div className="workspace-stat-grid">
        {summaryStats.map((item) => (
          <div key={item.label} className="workspace-stat">
            <span className="workspace-stat__label">{item.label}</span>
            <Statistic value={item.value} />
          </div>
        ))}
      </div>

      {actionError ? (
        <Alert
          type="error"
          showIcon
          message={actionError}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <div className="workspace-board workspace-board--knowledge">
        <div className="workspace-main">
          <section className="workspace-panel">
            <div className="section-heading">
              <div>
                <span className="section-heading__eyebrow">Sources</span>
                <h3 className="section-heading__title">Indexed sources</h3>
                <p className="section-heading__body">
                  Review what is available for grounding and remove anything you
                  no longer want in the local library.
                </p>
              </div>
            </div>

            {sources.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No sources indexed yet"
              />
            ) : (
              <List
                className="knowledge-source-list workspace-list"
                dataSource={sources}
                renderItem={(source) => (
                  <List.Item className="knowledge-source-row workspace-list-row">
                    <div className="knowledge-source-row__body">
                      <div className="knowledge-source-row__header">
                        <span className="knowledge-source-icon">
                          {iconForSource(source)}
                        </span>

                        <div className="knowledge-source-copy">
                          <div className="knowledge-source-title">
                            <span>{source.displayName}</span>
                            <Space size={8} wrap>
                              <Tag>{labelForModality(source.modality)}</Tag>
                              <Tag
                                color={
                                  source.status === "ready"
                                    ? "success"
                                    : "default"
                                }
                              >
                                {source.status}
                              </Tag>
                            </Space>
                          </div>
                          {source.error ? (
                            <Text
                              type="danger"
                              className="knowledge-source-error"
                            >
                              {source.error}
                            </Text>
                          ) : null}
                        </div>
                      </div>

                      <Button
                        type="text"
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        loading={deletingSourceId === source.id}
                        onClick={() =>
                          void handleDeleteSource(source.id, source.displayName)
                        }
                      >
                        Delete
                      </Button>
                    </div>
                  </List.Item>
                )}
              />
            )}
          </section>

          <section className="workspace-panel knowledge-activity-section">
            <div className="section-heading">
              <div>
                <span className="section-heading__eyebrow">Activity</span>
                <h3 className="section-heading__title">Ingest progress</h3>
                <p className="section-heading__body">
                  Track recent file and URL indexing work as it moves through
                  extraction, embedding, and local storage.
                </p>
              </div>
            </div>

            {ingestProgress.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No recent ingest activity"
              />
            ) : (
              <div className="knowledge-progress-list">
                {ingestProgress.map((item) => {
                  const stageTone = toneForStage(item.stage);
                  const progressStatus =
                    item.stage === "error"
                      ? "exception"
                      : item.stage === "complete"
                        ? "success"
                        : "active";
                  const displayName = displayNameForProgress(item);
                  const updatedAt = formatProgressTime(item.updatedAt);

                  return (
                    <div
                      key={`${item.sourceId ?? "pending"}-${item.locator}`}
                      className={`knowledge-progress-row knowledge-progress-row--${stageTone}`}
                    >
                      <div className="knowledge-progress-row__topline">
                        <span className="knowledge-progress-icon">
                          {iconForStage(item.stage)}
                        </span>
                        <div className="knowledge-progress-copy">
                          <div className="knowledge-progress-title">
                            <span>{displayName}</span>
                            <Tag
                              color={
                                item.stage === "complete"
                                  ? "success"
                                  : item.stage === "error"
                                    ? "error"
                                    : "processing"
                              }
                            >
                              {labelForStage(item.stage)}
                            </Tag>
                          </div>
                          <Text className="knowledge-progress-message">
                            {item.error ??
                              item.message ??
                              "Preparing Knowledge source"}
                          </Text>
                        </div>
                        {updatedAt ? (
                          <Text className="knowledge-progress-time">
                            {updatedAt}
                          </Text>
                        ) : null}
                      </div>

                      <Progress
                        percent={progressForStage(item.stage)}
                        status={progressStatus}
                        showInfo={false}
                        size="small"
                      />

                      {item.chunkCount != null ? (
                        <Text className="knowledge-progress-meta">
                          {item.chunkCount}{" "}
                          {item.chunkCount === 1 ? "chunk" : "chunks"}
                        </Text>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

        </div>

        <div className="workspace-aside">
          <section className="workspace-panel">
            <div className="section-heading">
              <div>
                <span className="section-heading__eyebrow">Ingest</span>
                <h3 className="section-heading__title">Add sources</h3>
                <p className="section-heading__body">
                  Add individual files from your device or paste a URL you want
                  Friday to fetch and index.
                </p>
              </div>
            </div>

            <div className="knowledge-action-grid">
              <Button
                icon={<FileAddOutlined />}
                onClick={() => void handlePickFiles()}
                loading={isPickingFiles}
                className="secondary-action knowledge-action-button"
              >
                Add file
              </Button>

              <div className="knowledge-url-card">
                <Text className="settings-field__label">Add a URL</Text>
                <Text className="settings-field__body">
                  Friday fetches content only for the explicit link you add
                  here.
                </Text>
                <div className="knowledge-url-row">
                  <Input
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://example.com/article"
                    prefix={<LinkOutlined />}
                    onPressEnter={() => void handleSubmitUrl()}
                  />
                  <Button
                    type="primary"
                    onClick={() => void handleSubmitUrl()}
                    loading={isSubmittingUrl}
                    disabled={!url.trim()}
                    className="primary-action"
                  >
                    Add URL
                  </Button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {isBusy ? (
        <Text type="secondary" className="knowledge-busy-hint">
          {status?.message ?? "Knowledge is working…"}
        </Text>
      ) : null}
    </div>
  );
}
