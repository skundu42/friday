import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Input,
  Progress,
  Space,
  Typography,
} from "antd";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CloudDownloadOutlined,
  RobotOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppSettings,
  AppSettingsInput,
  DownloadProgress,
  SetupStatus,
} from "../types";
import AppLogo from "./AppLogo";

const { Title, Text, Paragraph } = Typography;

type StepKey = "welcome" | "name" | "system" | "download" | "ready";
const STEP_ORDER: StepKey[] = [
  "welcome",
  "name",
  "system",
  "download",
  "ready",
];

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatEta(seconds: number): string {
  if (seconds === 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSpeed(bps: number): string {
  if (bps === 0) return "—";
  return `${formatBytes(bps)}/s`;
}

function estimateModelBytes(setupStatus: SetupStatus | null): number {
  return Math.round((setupStatus?.modelSizeGb ?? 0) * 1024 * 1024 * 1024);
}

function getNextValidStep(currentStepKey: StepKey, stepKeys: StepKey[]): StepKey {
  const currentIndex = STEP_ORDER.indexOf(currentStepKey);
  return (
    stepKeys.find((stepKey) => STEP_ORDER.indexOf(stepKey) > currentIndex) ??
    stepKeys[stepKeys.length - 1] ??
    "welcome"
  );
}

function hasConcreteDownloadProgress(progress: DownloadProgress | null): boolean {
  if (!progress) return false;
  return (
    progress.state === "complete" ||
    progress.totalBytes > 0 ||
    progress.downloadedBytes > 0 ||
    progress.percentage > 0
  );
}

function mergeDownloadProgress(
  previous: DownloadProgress | null,
  incoming: DownloadProgress,
  setupStatus: SetupStatus | null,
): DownloadProgress {
  const totalBytes =
    incoming.totalBytes || previous?.totalBytes || estimateModelBytes(setupStatus);
  const downloadedBytes =
    incoming.state === "complete"
      ? totalBytes
      : incoming.downloadedBytes ||
        previous?.downloadedBytes ||
        setupStatus?.partialDownloadBytes ||
        0;
  const percentage =
    incoming.state === "complete"
      ? 100
      : incoming.percentage ||
        (totalBytes > 0
          ? Math.round((downloadedBytes / totalBytes) * 100)
          : previous?.percentage ?? 0);

  return {
    ...incoming,
    displayName:
      incoming.displayName ||
      previous?.displayName ||
      setupStatus?.modelDisplayName ||
      "Local model",
    downloadedBytes,
    totalBytes,
    percentage: Math.min(percentage, 100),
  };
}

interface Props {
  settings: AppSettings;
  onSaveSettings: (input: AppSettingsInput) => Promise<AppSettings>;
  onComplete: () => void;
}

export default function SetupWizard({
  settings,
  onSaveSettings,
  onComplete,
}: Props) {
  const [currentStepKey, setCurrentStepKey] = useState<StepKey>("welcome");
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgress | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState(settings.user_display_name);
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [isSavingName, setIsSavingName] = useState(false);
  const [isLaunchingAssistant, setIsLaunchingAssistant] = useState(false);
  const warmupPromiseRef = useRef<Promise<void> | null>(null);
  const setupStatusRef = useRef<SetupStatus | null>(null);

  const needsDisplayName = settings.user_display_name.trim().length === 0;
  const requiresModelSetup = !(setupStatus?.readyToChat ?? false);
  const stepKeys = useMemo<StepKey[]>(
    () => [
      "welcome",
      ...(needsDisplayName ? (["name"] as StepKey[]) : []),
      ...(requiresModelSetup ? (["system", "download"] as StepKey[]) : []),
      "ready",
    ],
    [needsDisplayName, requiresModelSetup],
  );
  const currentStep = Math.max(stepKeys.indexOf(currentStepKey), 0);

  useEffect(() => {
    setDisplayName(settings.user_display_name);
  }, [settings.user_display_name]);

  useEffect(() => {
    if (stepKeys.includes(currentStepKey)) {
      return;
    }
    setCurrentStepKey(getNextValidStep(currentStepKey, stepKeys));
  }, [currentStepKey, stepKeys]);

  useEffect(() => {
    invoke<SetupStatus>("get_setup_status")
      .then((status) => {
        setSetupStatus(status);
      })
      .catch((err) => {
        console.error("[SetupWizard] get_setup_status error:", err);
      });
  }, []);

  useEffect(() => {
    setupStatusRef.current = setupStatus;
  }, [setupStatus]);

  const startAssistantWarmup = () => {
    if (!setupStatus?.readyToChat || warmupPromiseRef.current) {
      return warmupPromiseRef.current;
    }

    setIsLaunchingAssistant(true);
    warmupPromiseRef.current = invoke("warm_backend")
      .then(() => undefined)
      .catch((error) => {
        warmupPromiseRef.current = null;
        console.warn("[SetupWizard] warm_backend error:", error);
      })
      .finally(() => {
        setIsLaunchingAssistant(false);
      });

    return warmupPromiseRef.current;
  };

  useEffect(() => {
    if (!setupStatus?.readyToChat) {
      return;
    }
    void startAssistantWarmup();
  }, [setupStatus?.readyToChat]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    void listen<DownloadProgress>("model-download-progress", (event) => {
      setDownloadProgress((previous) => {
        const next = mergeDownloadProgress(
          previous,
          event.payload,
          setupStatusRef.current,
        );

        if (next.state === "complete") {
          setIsDownloading(false);
          setCurrentStepKey("ready");
          void invoke<SetupStatus>("get_setup_status")
            .then((status) => setSetupStatus(status))
            .catch(() => undefined);
        }

        if (next.state === "error") {
          setIsDownloading(false);
          setDownloadError(next.error || "Download failed");
        }

        return next;
      });
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((error) => {
        console.error("[SetupWizard] model-download-progress listen error:", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const startDownload = async () => {
    const totalBytes = estimateModelBytes(setupStatus);
    const partialBytes = setupStatus?.partialDownloadBytes ?? 0;
    setIsDownloading(true);
    setDownloadError(null);
    setDownloadProgress({
      state: "verifying",
      displayName: setupStatus?.modelDisplayName || "Local model",
      downloadedBytes: partialBytes,
      totalBytes,
      speedBps: 0,
      etaSeconds: 0,
      percentage: totalBytes > 0 ? Math.round((partialBytes / totalBytes) * 100) : 0,
    });

    try {
      await invoke<string>("pull_model");
      const status = await invoke<SetupStatus>("get_setup_status");
      setSetupStatus(status);
      if (status.modelDownloaded) {
        const completedBytes = estimateModelBytes(status);
        setDownloadProgress({
          state: "complete",
          displayName: status.modelDisplayName,
          downloadedBytes: completedBytes,
          totalBytes: completedBytes,
          speedBps: 0,
          etaSeconds: 0,
          percentage: 100,
        });
        setIsDownloading(false);
        setCurrentStepKey("ready");
      }
    } catch (err) {
      setIsDownloading(false);
      const msg = typeof err === "string" ? err : "Download failed";
      setDownloadError(msg);
      setDownloadProgress((prev) =>
        prev ? { ...prev, state: "error", error: msg } : null,
      );
      console.error("[SetupWizard] pull_model error:", err);
    }
  };

  const saveDisplayName = async () => {
    const normalizedName = displayName.trim().replace(/\s+/g, " ");
    if (!normalizedName) {
      setDisplayNameError("Please enter the name Friday should use.");
      return;
    }

    setIsSavingName(true);
    setDisplayNameError(null);
    try {
      await onSaveSettings({
        auto_start_backend: settings.auto_start_backend,
        user_display_name: normalizedName,
        theme_mode: settings.theme_mode,
        chat: settings.chat,
      });
      setCurrentStepKey(requiresModelSetup ? "system" : "ready");
    } catch (error) {
      setDisplayNameError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setIsSavingName(false);
    }
  };

  const handleComplete = async () => {
    await startAssistantWarmup();
    onComplete();
  };

  const stepItems = stepKeys.map((key) => {
    switch (key) {
      case "welcome":
        return { title: "Welcome", icon: <RobotOutlined /> };
      case "name":
        return { title: "Your Name", icon: <UserOutlined /> };
      case "system":
        return { title: "System", icon: <SafetyCertificateOutlined /> };
      case "download":
        return { title: "Download", icon: <CloudDownloadOutlined /> };
      case "ready":
        return { title: "Ready", icon: <RocketOutlined /> };
    }
  });
  const renderWelcome = () => (
    <div className="setup-stage__inner">
      <div className="setup-hero-logo">
        <AppLogo
          size={120}
          borderColor="rgba(47, 143, 87, 0.18)"
          borderWidth={1}
          background="var(--friday-green-soft)"
          padding={10}
          imageOffsetY={2}
        />
      </div>
      <Title level={2} style={{ textAlign: "center", marginBottom: 8 }}>
        Welcome to Friday
      </Title>
      <Paragraph
        type="secondary"
        style={{ fontSize: 16, lineHeight: 1.7, marginBottom: 28, textAlign: "center" }}
      >
        Your private AI assistant that runs <strong>on this device</strong> by
        default. Setup installs the local runtime and downloads your chosen
        model once.
      </Paragraph>
      {requiresModelSetup ? (
        <div className="setup-notice">
          <Text strong style={{ color: "var(--friday-warning)" }}>
            One-time setup
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 13 }}>
            Friday will download{" "}
            {setupStatus?.modelDisplayName ?? "your local model"} (
            {setupStatus?.modelSizeGb.toFixed(1) || "2.4"} GB). Internet access
            is only needed for this setup step.
          </Text>
        </div>
      ) : null}
      <div className="setup-stage__actions">
        <Button
          type="primary"
          size="large"
          block
          className="primary-action"
          onClick={() =>
            setCurrentStepKey(
              needsDisplayName ? "name" : requiresModelSetup ? "system" : "ready",
            )
          }
        >
          Let&apos;s Get Started
        </Button>
      </div>
    </div>
  );

  const renderDisplayName = () => (
    <div className="setup-stage__inner">
      <Title level={3} style={{ textAlign: "center", marginBottom: 8 }}>
        What Should Friday Call You?
      </Title>
      <Paragraph
        type="secondary"
        style={{ textAlign: "center", marginBottom: 28 }}
      >
        Friday uses this in the app greeting and empty chat state.
      </Paragraph>
      <Card
        className="setup-form-card"
        style={{ marginBottom: 20 }}
      >
        <Text strong style={{ display: "block", marginBottom: 8 }}>
          Your name
        </Text>
        <Input
          value={displayName}
          placeholder="Enter your name"
          maxLength={60}
          size="large"
          status={displayNameError ? "error" : undefined}
          onChange={(event) => {
            setDisplayName(event.target.value);
            if (displayNameError) {
              setDisplayNameError(null);
            }
          }}
          onPressEnter={() => void saveDisplayName()}
        />
        <Text type={displayNameError ? "danger" : "secondary"} style={{ display: "block", marginTop: 8 }}>
          {displayNameError ||
            "This is only used for Friday's greeting inside the app."}
        </Text>
      </Card>
      <div className="setup-stage__actions">
        <Button
          type="primary"
          size="large"
          block
          loading={isSavingName}
          className="primary-action"
          onClick={() => void saveDisplayName()}
        >
          Continue
        </Button>
      </div>
    </div>
  );

  const renderSystemCheck = () => {
    const ramGb = setupStatus?.totalRamGb ?? 0;
    const meetsRam = setupStatus?.meetsRamMinimum ?? false;
    const checks = [
      {
        label: "RAM",
        value: `${ramGb.toFixed(1)} GB`,
        pass: meetsRam,
        note: meetsRam
          ? `Enough memory for ${setupStatus?.modelDisplayName ?? "the selected model"}`
          : `Needs at least ${(setupStatus?.minRamGb ?? 4).toFixed(0)} GB`,
      },
      {
        label: "AI Model",
        value: setupStatus?.modelDownloaded
          ? "Downloaded"
          : `${setupStatus?.modelSizeGb.toFixed(1) ?? "2.4"} GB download`,
        pass: true,
        note: setupStatus?.modelDownloaded
          ? `${setupStatus?.modelDisplayName ?? "The model"} is ready`
          : "Will download during setup",
      },
      {
        label: "Privacy",
        value: "100% Local",
        pass: true,
        note: "Runs on-device by default after setup",
      },
    ];

    const allPassed = checks.every((check) => check.pass);

    return (
      <div className="setup-stage__inner">
        <Title level={3} style={{ textAlign: "center", marginBottom: 24 }}>
          System Check
        </Title>
        <div className="setup-check-list">
          {checks.map((check) => (
            <Card
              key={check.label}
              size="small"
              className={`setup-check-card ${check.pass ? "is-pass" : "is-fail"}`}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <Text strong style={{ fontSize: 15 }}>
                    {check.label}
                  </Text>
                  <br />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {check.note}
                  </Text>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Text strong>{check.value}</Text>
                  {check.pass ? (
                    <CheckCircleFilled
                      style={{ color: "var(--friday-green)", fontSize: 20 }}
                    />
                  ) : (
                    <CloseCircleFilled
                      style={{ color: "var(--friday-danger)", fontSize: 20 }}
                    />
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
        <div className="setup-stage__actions">
          <Button
            type="primary"
            size="large"
            block
            disabled={!allPassed}
            className="primary-action"
            onClick={() => {
              setCurrentStepKey("download");
              void startDownload();
            }}
          >
            {allPassed
              ? "Looks Good — Download Model"
              : "System Requirements Not Met"}
          </Button>
        </div>
      </div>
    );
  };

  const renderDownload = () => {
    const progress = downloadProgress;
    const percentage = progress?.percentage ?? 0;
    const isComplete = progress?.state === "complete";
    const isPreparing = progress?.state === "verifying";
    const hasConcreteProgress = hasConcreteDownloadProgress(progress);

    return (
      <div className="setup-stage__inner">
        <Title level={3} style={{ textAlign: "center", marginBottom: 8 }}>
          {isComplete
              ? "Setup Complete!"
              : isPreparing
                ? "Preparing Friday..."
              : `Downloading ${setupStatus?.modelDisplayName ?? "your model"}...`}
        </Title>
        <Paragraph
          type="secondary"
          style={{ textAlign: "center", marginBottom: 32 }}
        >
          {isComplete
            ? "Your model is ready to use."
            : isPreparing
              ? "Friday is preparing the local runtime on this device."
              : !hasConcreteProgress
                ? "Friday is downloading your local model."
                : "This usually takes a few minutes, depending on your connection."}
        </Paragraph>

        <Card className="setup-progress-card" style={{ marginBottom: 20 }}>
          {hasConcreteProgress ? (
            <>
              <Progress
                percent={percentage}
                status={
                  downloadError ? "exception" : isComplete ? "success" : "active"
                }
                strokeColor={{
                  "0%": "var(--friday-green)",
                  "100%": "var(--friday-green-strong)",
                }}
                trailColor="var(--friday-surface-muted)"
                size={["100%", 20]}
                style={{ marginBottom: 16 }}
              />

              <div className="setup-progress-grid">
                <div className="setup-progress-stat">
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    Downloaded
                  </Text>
                  <br />
                  <Text strong>{formatBytes(progress?.downloadedBytes ?? 0)}</Text>
                </div>
                <div className="setup-progress-stat">
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    Speed
                  </Text>
                  <br />
                  <Text strong>{formatSpeed(progress?.speedBps ?? 0)}</Text>
                </div>
                <div className="setup-progress-stat">
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    ETA
                  </Text>
                  <br />
                  <Text strong>{formatEta(progress?.etaSeconds ?? 0)}</Text>
                </div>
              </div>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "12px 0 4px" }}>
              <CloudDownloadOutlined
                spin
                style={{ fontSize: 28, color: "var(--friday-green)", marginBottom: 12 }}
              />
              <div>
                <Text strong>
                  {isPreparing ? "Preparing local runtime" : "Download in progress"}
                </Text>
              </div>
              <Text type="secondary" style={{ fontSize: 13 }}>
                {isPreparing
                  ? "Friday is unpacking the bundled runtime before the model download begins."
                  : `${setupStatus?.modelSizeGb.toFixed(1) ?? "2.4"} GB model download in progress.`}
              </Text>
            </div>
          )}
        </Card>

        {(setupStatus?.partialDownloadBytes ?? 0) > 0 &&
        !isDownloading &&
        !downloadError ? (
          <div className="setup-inline-message setup-inline-message--info">
            <Text style={{ color: "var(--friday-info)", fontSize: 13 }}>
              Resuming from {formatBytes(setupStatus?.partialDownloadBytes ?? 0)}{" "}
              already downloaded
            </Text>
          </div>
        ) : null}

        {downloadError ? (
          <div className="setup-inline-message setup-inline-message--error">
            <Text style={{ color: "var(--friday-danger)", fontSize: 13 }}>
              {downloadError}
            </Text>
          </div>
        ) : null}

        {downloadError ? (
          <Button
            size="large"
            block
            className="secondary-action"
            style={{ height: 48 }}
            onClick={() => {
              setDownloadError(null);
              void startDownload();
            }}
          >
            Retry Download
          </Button>
        ) : null}
      </div>
    );
  };

  const renderReady = () => (
    <div className="setup-stage__inner">
      <div className="setup-ready-card">
        <AppLogo
          size={108}
          borderColor="rgba(47, 143, 87, 0.18)"
          borderWidth={1}
          background="var(--friday-green-soft)"
          padding={10}
          imageOffsetY={2}
        />
        <Title level={2} className="setup-ready-card__title">
          {(settings.user_display_name.trim() || displayName.trim())
            ? `You're All Set, ${(settings.user_display_name.trim() || displayName.trim())}!`
            : "You're All Set!"}
        </Title>
        <Paragraph className="setup-ready-card__body">
          <strong>{setupStatus?.modelDisplayName ?? "Your local model"}</strong>{" "}
          is ready. Friday now runs on-device by default and keeps your chats on
          this machine.
        </Paragraph>
        <Button
          type="primary"
          size="large"
          loading={isLaunchingAssistant}
          className="primary-action"
          style={{ minWidth: 240 }}
          onClick={() => {
            void handleComplete();
          }}
        >
          <RocketOutlined /> Start Chatting
        </Button>
      </div>
    </div>
  );

  const renderStep = () => {
    switch (currentStepKey) {
      case "welcome":
        return renderWelcome();
      case "name":
        return renderDisplayName();
      case "system":
        return renderSystemCheck();
      case "download":
        return renderDownload();
      case "ready":
        return renderReady();
      default:
        return renderWelcome();
    }
  };

  return (
    <div className="setup-shell">
      <div className="setup-panel surface-card">
        <div className="setup-rail">
          <div className="setup-rail__brand">
            <AppLogo size={54} />
            <div>
              <Title level={4} className="setup-rail__title">
                Friday
              </Title>
              <Paragraph className="setup-rail__body">
                Private local AI setup with one guided flow.
              </Paragraph>
            </div>
          </div>

          <div className="setup-step-list">
            {stepItems.map((item, index) => {
              const stateClass =
                index === currentStep
                  ? " is-current"
                  : index < currentStep
                    ? " is-complete"
                    : "";

              return (
                <div key={item.title} className={`setup-step${stateClass}`}>
                  <span className="setup-step__icon">{item.icon}</span>
                  <div>
                    <Text strong>{item.title}</Text>
                  </div>
                </div>
              );
            })}
          </div>

          <Text className="setup-rail__footer">Friday v0.1.0</Text>
        </div>

        <div className="setup-stage">{renderStep()}</div>
      </div>
    </div>
  );
}
