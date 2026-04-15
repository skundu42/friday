import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Input,
  Progress,
  Result,
  Space,
  Steps,
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

  const startAssistantWarmup = () => {
    if (
      !settings.auto_start_backend ||
      !setupStatus?.readyToChat ||
      warmupPromiseRef.current
    ) {
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
    if (!setupStatus?.readyToChat || !settings.auto_start_backend) {
      return;
    }
    void startAssistantWarmup();
  }, [settings.auto_start_backend, setupStatus?.readyToChat]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<DownloadProgress>("model-download-progress", (event) => {
      setDownloadProgress((previous) => {
        const next = mergeDownloadProgress(previous, event.payload, setupStatus);

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
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [setupStatus]);

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
  const stepRailMinWidth = Math.max(stepItems.length * 120, 480);

  const renderWelcome = () => (
    <div style={{ textAlign: "center", maxWidth: 480, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
        <AppLogo
          size={120}
          borderColor="#52C41A"
          borderWidth={3}
          background="#F6FFED"
          padding={10}
        />
      </div>
      <Title level={2} style={{ marginBottom: 8 }}>
        Welcome to Friday
      </Title>
      <Paragraph
        type="secondary"
        style={{ fontSize: 16, lineHeight: 1.7, marginBottom: 32 }}
      >
        Your private AI assistant that runs <strong>on this device</strong> by
        default. Setup installs the local runtime and downloads your chosen
        model once.
      </Paragraph>
      {requiresModelSetup ? (
        <div
          style={{
            background: "#FFF7E6",
            border: "2px solid #FFD666",
            borderRadius: 12,
            padding: "16px 20px",
            marginBottom: 32,
            textAlign: "left",
          }}
        >
          <Text strong style={{ color: "#AD6800" }}>
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
      <Button
        type="primary"
        size="large"
        block
        style={{
          height: 56,
          fontSize: 18,
          fontWeight: 600,
          borderRadius: 12,
          background: "#52C41A",
          border: "3px solid #2C2C2C",
          boxShadow: "4px 4px 0px #2C2C2C",
        }}
        onClick={() =>
          setCurrentStepKey(
            needsDisplayName ? "name" : requiresModelSetup ? "system" : "ready",
          )
        }
      >
        Let&apos;s Get Started →
      </Button>
    </div>
  );

  const renderDisplayName = () => (
    <div style={{ maxWidth: 480, margin: "0 auto" }}>
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
        style={{
          border: "3px solid #2C2C2C",
          borderRadius: 12,
          boxShadow: "4px 4px 0px #2C2C2C",
          marginBottom: 20,
        }}
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
      <Button
        type="primary"
        size="large"
        block
        loading={isSavingName}
        style={{
          height: 52,
          fontSize: 16,
          fontWeight: 600,
          borderRadius: 12,
          background: "#52C41A",
          border: "3px solid #2C2C2C",
          boxShadow: "4px 4px 0px #2C2C2C",
        }}
        onClick={() => void saveDisplayName()}
      >
        Continue →
      </Button>
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
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <Title level={3} style={{ textAlign: "center", marginBottom: 24 }}>
          System Check
        </Title>
        <Space direction="vertical" style={{ width: "100%" }} size={16}>
          {checks.map((check) => (
            <Card
              key={check.label}
              size="small"
              style={{
                border: `3px solid ${check.pass ? "#52C41A" : "#FF4D4F"}`,
                borderRadius: 12,
                boxShadow: check.pass
                  ? "3px 3px 0px #52C41A33"
                  : "3px 3px 0px #FF4D4F33",
              }}
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
                      style={{ color: "#52C41A", fontSize: 20 }}
                    />
                  ) : (
                    <CloseCircleFilled
                      style={{ color: "#FF4D4F", fontSize: 20 }}
                    />
                  )}
                </div>
              </div>
            </Card>
          ))}
        </Space>
        <Button
          type="primary"
          size="large"
          block
          disabled={!allPassed}
          style={{
            height: 52,
            fontSize: 16,
            fontWeight: 600,
            borderRadius: 12,
            marginTop: 28,
            background: "#52C41A",
            border: "3px solid #2C2C2C",
            boxShadow: "4px 4px 0px #2C2C2C",
          }}
          onClick={() => {
            setCurrentStepKey("download");
            void startDownload();
          }}
        >
          {allPassed
            ? "Looks Good — Download Model →"
            : "System Requirements Not Met"}
        </Button>
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
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
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

        <Card
          style={{
            border: "3px solid #2C2C2C",
            borderRadius: 12,
            boxShadow: "4px 4px 0px #2C2C2C",
            marginBottom: 20,
          }}
        >
          {hasConcreteProgress ? (
            <>
              <Progress
                percent={percentage}
                status={
                  downloadError ? "exception" : isComplete ? "success" : "active"
                }
                strokeColor={{
                  "0%": "#52C41A",
                  "100%": "#73D13D",
                }}
                trailColor="#F0F0F0"
                size={["100%", 20]}
                style={{ marginBottom: 16 }}
              />

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 12,
                  textAlign: "center",
                }}
              >
                <div>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    Downloaded
                  </Text>
                  <br />
                  <Text strong>{formatBytes(progress?.downloadedBytes ?? 0)}</Text>
                </div>
                <div>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    Speed
                  </Text>
                  <br />
                  <Text strong>{formatSpeed(progress?.speedBps ?? 0)}</Text>
                </div>
                <div>
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
                style={{ fontSize: 28, color: "#52C41A", marginBottom: 12 }}
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
          <div
            style={{
              background: "#E6F7FF",
              border: "2px solid #91D5FF",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 16,
            }}
          >
            <Text style={{ color: "#0050B3", fontSize: 13 }}>
              Resuming from {formatBytes(setupStatus?.partialDownloadBytes ?? 0)}{" "}
              already downloaded
            </Text>
          </div>
        ) : null}

        {downloadError ? (
          <div
            style={{
              background: "#FFF2F0",
              border: "2px solid #FFCCC7",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 16,
            }}
          >
            <Text style={{ color: "#CF1322", fontSize: 13 }}>
              {downloadError}
            </Text>
          </div>
        ) : null}

        {downloadError ? (
          <Button
            size="large"
            block
            style={{
              height: 48,
              borderRadius: 12,
              border: "3px solid #2C2C2C",
              fontWeight: 600,
            }}
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
    <Result
      icon={<span style={{ fontSize: 72 }}>🎉</span>}
      title={
        <Title level={2}>
          {(settings.user_display_name.trim() || displayName.trim())
            ? `You're All Set, ${(settings.user_display_name.trim() || displayName.trim())}!`
            : "You're All Set!"}
        </Title>
      }
      subTitle={
        <Paragraph style={{ fontSize: 16, maxWidth: 400, margin: "0 auto" }}>
          <strong>{setupStatus?.modelDisplayName ?? "Your local model"}</strong>{" "}
          is ready. Friday now runs on-device by default and keeps your chats on
          this machine.
        </Paragraph>
      }
      extra={
        <Button
          type="primary"
          size="large"
          loading={isLaunchingAssistant}
          style={{
            height: 56,
            fontSize: 18,
            fontWeight: 600,
            borderRadius: 12,
            background: "#52C41A",
            border: "3px solid #2C2C2C",
            boxShadow: "4px 4px 0px #2C2C2C",
            minWidth: 240,
          }}
          onClick={() => {
            void handleComplete();
          }}
        >
          <RocketOutlined /> Start Chatting
        </Button>
      }
      style={{ padding: "40px 0" }}
    />
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
    <div
      style={{
        height: "100vh",
        background: "#FFF9F0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 40,
      }}
    >
      <div style={{ width: "100%", maxWidth: 720, marginBottom: 48 }}>
        <div style={{ overflowX: "auto", paddingBottom: 8 }}>
          <div style={{ minWidth: stepRailMinWidth, paddingInline: 8 }}>
            <Steps
              current={currentStep}
              items={stepItems}
              size="small"
              responsive={false}
            />
          </div>
        </div>
      </div>

      <div style={{ width: "100%", maxWidth: 520 }}>{renderStep()}</div>

      <Text
        type="secondary"
        style={{
          position: "fixed",
          bottom: 20,
          fontSize: 12,
          opacity: 0.5,
        }}
      >
        Friday v0.1.0
      </Text>
    </div>
  );
}
