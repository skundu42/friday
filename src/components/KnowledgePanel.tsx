import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  List,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import {
  AudioOutlined,
  DeleteOutlined,
  FileAddOutlined,
  FileImageOutlined,
  FileTextOutlined,
  GlobalOutlined,
  LinkOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  KnowledgeIngestProgress,
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

export default function KnowledgePanel({
  status,
  sources,
  stats,
  ingestProgress = [],
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
    <div className="knowledge-panel">
      <section className="knowledge-hero surface-card surface-card--accent">
        <div className="knowledge-hero__header">
          <div className="settings-header settings-header--page">
            <Title level={3} className="settings-header__title">
              Knowledge
            </Title>
            <Paragraph className="settings-header__body">
              Build a local library that Friday can use to ground replies
              against your files and explicitly added URLs.
            </Paragraph>
          </div>

          <Button
            icon={<ReloadOutlined />}
            onClick={() => void handleRefresh()}
            loading={isRefreshing}
            className="secondary-action"
          >
            Refresh
          </Button>
        </div>

        <Alert
          showIcon
          type={toneForStatus(status)}
          message={status?.message ?? "Knowledge status is unavailable."}
        />

        <div className="knowledge-stats-grid">
          {summaryStats.map((item) => (
            <div key={item.label} className="knowledge-stats-card">
              <Statistic title={item.label} value={item.value} />
            </div>
          ))}
        </div>
      </section>

      {actionError ? (
        <Alert
          type="error"
          showIcon
          message={actionError}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <div className="knowledge-layout">
        <div className="knowledge-stack knowledge-stack--main">
          <section className="settings-section surface-card">
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
                className="knowledge-source-list"
                dataSource={sources}
                renderItem={(source) => (
                  <List.Item className="knowledge-source-row">
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

          {ingestProgress.length > 0 ? (
            <section className="settings-section surface-card">
              <div className="section-heading">
                <div>
                  <span className="section-heading__eyebrow">Progress</span>
                  <h3 className="section-heading__title">
                    Recent ingest activity
                  </h3>
                  <p className="section-heading__body">
                    Friday streams ingest state per source so long-running
                    indexing work stays visible.
                  </p>
                </div>
              </div>

              <List
                dataSource={ingestProgress}
                renderItem={(item) => (
                  <List.Item>
                    <div className="knowledge-source-row__body">
                      <div className="knowledge-source-copy">
                        <div className="knowledge-source-title">
                          <span>{item.sourceId ?? item.locator}</span>
                          <Space size={8} wrap>
                            <Tag>{item.stage}</Tag>
                            {typeof item.chunkCount === "number" ? (
                              <Tag color="blue">{item.chunkCount} chunks</Tag>
                            ) : null}
                          </Space>
                        </div>
                        {item.message ? (
                          <Text type="secondary">{item.message}</Text>
                        ) : null}
                        {item.error ? (
                          <Text
                            type="danger"
                            className="knowledge-source-error"
                          >
                            {item.error}
                          </Text>
                        ) : null}
                      </div>
                    </div>
                  </List.Item>
                )}
              />
            </section>
          ) : null}
        </div>

        <div className="knowledge-stack knowledge-stack--side">
          <section className="settings-section surface-card">
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
