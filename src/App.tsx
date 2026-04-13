import { lazy, Suspense, useEffect, useState } from "react";
import { Drawer, Layout, Spin, Typography } from "antd";
import { invoke } from "@tauri-apps/api/core";
import Sidebar from "./components/Sidebar";
import ChatPane from "./components/ChatPane";
import { useAppController } from "./hooks/useAppController";
import type { ReplyLanguage, SetupStatus } from "./types";

const { Sider, Content } = Layout;
const { Text } = Typography;

const SettingsPanel = lazy(() => import("./components/SettingsPanel"));
const SetupWizard = lazy(() => import("./components/SetupWizard"));

function useNarrowLayout(breakpoint = 1080) {
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false,
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const sync = () => {
      setIsNarrow(window.innerWidth < breakpoint);
    };

    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [breakpoint]);

  return isNarrow;
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [wizardChecked, setWizardChecked] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const controller = useAppController();
  const isNarrowLayout = useNarrowLayout();

  const readyForSettings = controller.settings && controller.backendStatus;

  useEffect(() => {
    setSidebarOpen(!isNarrowLayout);
  }, [isNarrowLayout]);

  const handleCloseSettings = () => {
    setShowSettings(false);
    void controller.refreshBackendStatus();
  };

  const handleToggleSidebar = () => {
    setSidebarOpen((previous) => !previous);
  };

  const handleShowSettings = () => {
    if (isNarrowLayout) {
      setSidebarOpen(false);
    }
    setShowSettings(true);
  };

  const handleSelectSession = (sessionId: string) => {
    setShowSettings(false);
    if (isNarrowLayout) {
      setSidebarOpen(false);
    }
    void controller.selectSession(sessionId);
  };

  useEffect(() => {
    if (controller.isBootstrapping || wizardChecked || !controller.settings) {
      return;
    }

    let cancelled = false;
    void invoke<SetupStatus>("get_setup_status")
      .then((status) => {
        if (cancelled) {
          return;
        }
        if (
          !status.readyToChat ||
          !controller.settings.user_display_name.trim()
        ) {
          setShowWizard(true);
        }
        setWizardChecked(true);
      })
      .catch(() => {
        if (!cancelled) {
          setWizardChecked(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [controller.isBootstrapping, controller.settings, wizardChecked]);

  if (!controller.isBootstrapping && !wizardChecked) {
    return (
      <div
        style={{
          height: "100vh",
          background: "#FFF9F0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <Spin size="large" />
        <Text type="secondary">Loading Friday...</Text>
      </div>
    );
  }

  if (showWizard) {
    return (
      <Suspense fallback={<PanelFallback label="Loading setup..." />}>
        <SetupWizard
          settings={controller.settings!}
          onSaveSettings={(input) => controller.saveAppSettings(input)}
          onComplete={() => {
            setShowWizard(false);
            controller.refreshBackendStatus();
          }}
        />
      </Suspense>
    );
  }

  return (
    <>
      <Layout style={{ height: "100vh", background: "#FFF9F0" }}>
        {!isNarrowLayout ? (
          <Sider
            width={280}
            collapsed={!sidebarOpen}
            collapsedWidth={0}
            trigger={null}
            style={{
              background: "#FFFFFF",
              borderRight: "3px solid #2C2C2C",
              overflow: "auto",
            }}
          >
            <Sidebar
              sessions={controller.sessions}
              activeSessionId={controller.activeSession?.id ?? ""}
              isBusy={controller.isGenerating}
              onCreateSession={() => void controller.createSession()}
              onSelectSession={handleSelectSession}
              onDeleteSession={(sessionId) =>
                void controller.deleteSession(sessionId)
              }
              onShowSettings={handleShowSettings}
            />
          </Sider>
        ) : null}

        <Layout style={{ background: "#FFF9F0", minWidth: 0 }}>
          <Content
            style={{
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {controller.isBootstrapping ? (
              <PanelFallback label="Starting Friday..." />
            ) : (
              <ChatPane
                messages={controller.messages}
                isGenerating={controller.isGenerating}
                generationStatus={controller.generationStatus}
                onSendMessage={(content, attachments) =>
                  controller.sendMessage(content, attachments)
                }
                onCancelGeneration={() => controller.cancelGeneration()}
                webSearchEnabled={controller.webSearchEnabled}
                thinkingEnabled={controller.thinkingEnabled}
                webSearchAvailable={controller.nativeToolSupportAvailable}
                thinkingAvailable={controller.thinkingAvailable}
                audioInputAvailable={controller.audioInputAvailable}
                onToggleWebSearch={() => controller.toggleWebSearch()}
                onToggleThinking={() => controller.toggleThinking()}
                activeSessionTitle={controller.activeSession?.title ?? "New chat"}
                userDisplayName={controller.settings?.user_display_name ?? ""}
                replyLanguage={
                  controller.settings?.chat.reply_language ?? "english"
                }
                onLanguageChange={(lang) =>
                  void controller.setReplyLanguage(lang as ReplyLanguage)
                }
                backendStatus={controller.backendStatus}
                onToggleSidebar={handleToggleSidebar}
                isSidebarOpen={sidebarOpen}
                isNarrowLayout={isNarrowLayout}
              />
            )}
          </Content>
        </Layout>
      </Layout>

      <Drawer
        title={null}
        placement="left"
        open={isNarrowLayout && sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        closable={false}
        width={300}
        styles={{
          header: { display: "none" },
          body: { padding: 0, background: "#FFFFFF" },
        }}
      >
        <Sidebar
          sessions={controller.sessions}
          activeSessionId={controller.activeSession?.id ?? ""}
          isBusy={controller.isGenerating}
          onCreateSession={() => void controller.createSession()}
          onSelectSession={handleSelectSession}
          onDeleteSession={(sessionId) => void controller.deleteSession(sessionId)}
          onShowSettings={handleShowSettings}
        />
      </Drawer>

      <Drawer
        title="Settings"
        placement="right"
        open={Boolean(showSettings && readyForSettings)}
        onClose={handleCloseSettings}
        width={440}
        mask={isNarrowLayout}
        styles={{
          header: {
            borderBottom: "3px solid #2C2C2C",
            background: "#FFF9F0",
            paddingInline: 20,
            paddingBlock: 16,
          },
          body: {
            padding: 20,
            background: "#FFF9F0",
          },
        }}
      >
        {readyForSettings ? (
          <Suspense fallback={<PanelFallback label="Loading settings..." />}>
            <SettingsPanel
              settings={controller.settings!}
              backendStatus={controller.backendStatus!}
              activeModelId={controller.activeModelId}
              isSwitchingModel={controller.isSwitchingModel}
              onModelChange={(modelId) => controller.selectModel(modelId)}
              onSaveSettings={(input) => controller.saveAppSettings(input)}
              isSaving={controller.isSavingSettings}
            />
          </Suspense>
        ) : (
          <PanelFallback label="Loading settings..." />
        )}
      </Drawer>
    </>
  );
}

function PanelFallback({ label }: { label: string }) {
  return (
    <div
      style={{
        height: "100%",
        minHeight: 320,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <Spin size="large" />
      <Text type="secondary">{label}</Text>
    </div>
  );
}
