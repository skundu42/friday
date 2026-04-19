import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  Alert,
  Button,
  ConfigProvider,
  Drawer,
  Layout,
  Spin,
  Typography,
} from "antd";
import { ArrowLeftOutlined, MenuOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import Sidebar from "./components/Sidebar";
import ChatPane from "./components/ChatPane";
import { useAppController } from "./hooks/useAppController";
import type { ReplyLanguage, SetupStatus, ThemeMode } from "./types";
import { buildIllustrationTheme } from "./theme/illustrationTheme";

const { Sider, Content } = Layout;
const { Text } = Typography;

const SettingsPanel = lazy(() => import("./components/SettingsPanel"));
const KnowledgePanel = lazy(() => import("./components/KnowledgePanel"));
const SetupWizard = lazy(() => import("./components/SetupWizard"));
type AppView = "chat" | "knowledge" | "settings";

function useNarrowLayout(breakpoint = 1080) {
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false,
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (typeof window.matchMedia === "function") {
      const mediaQuery = window.matchMedia(
        `(max-width: ${breakpoint - 0.02}px)`,
      );
      const sync = (event?: MediaQueryListEvent) => {
        setIsNarrow(event?.matches ?? mediaQuery.matches);
      };

      sync();
      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", sync);
        return () => mediaQuery.removeEventListener("change", sync);
      }

      mediaQuery.addListener(sync);
      return () => mediaQuery.removeListener(sync);
    }

    const sync = () => setIsNarrow(window.innerWidth < breakpoint);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [breakpoint]);

  return isNarrow;
}

export default function App() {
  const [activeView, setActiveView] = useState<AppView>("chat");
  const [showWizard, setShowWizard] = useState(false);
  const [wizardChecked, setWizardChecked] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [restartError, setRestartError] = useState<string | null>(null);
  const controller = useAppController();
  const isNarrowLayout = useNarrowLayout();
  const themeMode: ThemeMode = controller.settings?.theme_mode ?? "light";

  const readyForSettings = controller.settings && controller.backendStatus;

  useEffect(() => {
    setSidebarOpen(!isNarrowLayout);
  }, [isNarrowLayout]);

  useEffect(() => {
    document.body.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;

    return () => {
      delete document.body.dataset.theme;
      document.documentElement.style.removeProperty("color-scheme");
    };
  }, [themeMode]);

  const handleToggleSidebar = () => {
    setSidebarOpen((previous) => !previous);
  };

  const navigateToView = (nextView: AppView) => {
    if (activeView === "settings" && nextView !== "settings") {
      void controller.refreshBackendStatus();
    }
    if (nextView === "knowledge") {
      void controller.refreshKnowledge();
    }
    setActiveView(nextView);
  };

  const handleShowChat = () => {
    navigateToView("chat");
  };

  const handleShowSettings = () => {
    if (isNarrowLayout) {
      setSidebarOpen(false);
    }
    navigateToView("settings");
  };

  const handleShowKnowledge = () => {
    if (isNarrowLayout) {
      setSidebarOpen(false);
    }
    navigateToView("knowledge");
  };

  const handleSelectSession = (sessionId: string) => {
    navigateToView("chat");
    if (isNarrowLayout) {
      setSidebarOpen(false);
    }
    void controller.selectSession(sessionId);
  };

  const handleCreateSession = () => {
    navigateToView("chat");
    if (isNarrowLayout) {
      setSidebarOpen(false);
    }
    void controller.createSession();
  };

  const handleInstallUpdate = () => {
    void controller.installAppUpdate().catch((error) => {
      console.error("[App] installAppUpdate error:", error);
    });
  };

  const handleRestartForUpdate = () => {
    setRestartError(null);
    void controller.restartApp().catch((error) => {
      console.error("[App] restartApp error:", error);
      setRestartError(error instanceof Error ? error.message : String(error));
    });
  };

  useEffect(() => {
    const settings = controller.settings;
    if (
      controller.isBootstrapping ||
      controller.bootstrapError ||
      wizardChecked ||
      !settings
    ) {
      return;
    }

    let cancelled = false;
    void invoke<SetupStatus>("get_setup_status")
      .then((status) => {
        if (cancelled) {
          return;
        }
        if (!status.readyToChat || !settings.user_display_name.trim()) {
          setShowWizard(true);
        }
        setWizardChecked(true);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("[App] get_setup_status error:", error);
          setShowWizard(true);
          setWizardChecked(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    controller.bootstrapError,
    controller.isBootstrapping,
    controller.settings,
    wizardChecked,
  ]);

  if (controller.bootstrapError) {
    return (
      <ConfigProvider {...buildIllustrationTheme(themeMode)}>
        <div className="app-screen">
          <div className="app-screen__panel">
            <Alert
              type="error"
              showIcon
              message="Friday could not start"
              description={controller.bootstrapError}
              action={
                <Button onClick={() => window.location.reload()} size="small">
                  Retry
                </Button>
              }
            />
          </div>
        </div>
      </ConfigProvider>
    );
  }

  if (!controller.isBootstrapping && !wizardChecked) {
    return (
      <ConfigProvider {...buildIllustrationTheme(themeMode)}>
        <div className="app-screen">
          <Spin size="large" />
          <Text type="secondary">Loading Friday...</Text>
        </div>
      </ConfigProvider>
    );
  }

  if (showWizard) {
    return (
      <ConfigProvider {...buildIllustrationTheme(themeMode)}>
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
      </ConfigProvider>
    );
  }

  const showManualUpdateBanner = Boolean(
    controller.availableAppUpdate &&
      !controller.installedAppUpdateVersion &&
      (!controller.settings?.auto_download_updates ||
        Boolean(controller.appUpdateError)),
  );
  const manualUpdate = showManualUpdateBanner
    ? controller.availableAppUpdate
    : null;

  return (
    <ConfigProvider {...buildIllustrationTheme(themeMode)}>
      <Layout className="app-layout">
        {!isNarrowLayout ? (
          <Sider
            width={280}
            collapsed={!sidebarOpen}
            collapsedWidth={0}
            trigger={null}
            className="app-sider"
            style={{ overflow: "auto" }}
          >
            <Sidebar
              sessions={controller.sessions}
              activeSessionId={controller.activeSession?.id ?? ""}
              activeView={activeView}
              isBusy={controller.isGenerating}
              onCreateSession={handleCreateSession}
              onSelectSession={handleSelectSession}
              onDeleteSession={(sessionId) =>
                void controller.deleteSession(sessionId)
              }
              onShowKnowledge={handleShowKnowledge}
              onShowSettings={handleShowSettings}
            />
          </Sider>
        ) : null}

        <Layout className="app-content-shell">
          <Content className="app-content">
            {controller.isBootstrapping ? (
              <PanelFallback label="Starting Friday..." />
            ) : (
              <>
                {manualUpdate ? (
                  <div className="app-update-banner">
                    <Alert
                      type="info"
                      showIcon
                      message={`Update available: v${manualUpdate.version}`}
                      description={
                        manualUpdate.notes ??
                        "A new stable Friday release is ready to install."
                      }
                      action={
                        <Button
                          type="primary"
                          size="small"
                          loading={controller.isInstallingAppUpdate}
                          onClick={handleInstallUpdate}
                        >
                          Download & install
                        </Button>
                      }
                      closable
                      onClose={controller.dismissAppUpdate}
                    />
                  </div>
                ) : null}

                {controller.installedAppUpdateVersion ? (
                  <div className="app-update-banner">
                    <Alert
                      type="success"
                      showIcon
                      message={`Update installed: v${controller.installedAppUpdateVersion}`}
                      description="Restart Friday to finish applying the update."
                      action={
                        <Button
                          type="primary"
                          size="small"
                          onClick={handleRestartForUpdate}
                        >
                          Restart to Update
                        </Button>
                      }
                      closable
                      onClose={() => {
                        setRestartError(null);
                        controller.clearInstalledAppUpdateVersion();
                      }}
                    />
                  </div>
                ) : null}

                {controller.appUpdateError ? (
                  <div className="app-update-banner">
                    <Alert
                      type="warning"
                      showIcon
                      message="Auto-update failed"
                      description={controller.appUpdateError}
                      closable
                      onClose={controller.clearAppUpdateError}
                    />
                  </div>
                ) : null}

                {restartError ? (
                  <div className="app-update-banner">
                    <Alert
                      type="warning"
                      showIcon
                      message="Restart failed"
                      description={restartError}
                      closable
                      onClose={() => setRestartError(null)}
                    />
                  </div>
                ) : null}

                {activeView === "chat" ? (
                  <div className="app-view is-active">
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
                      webSearchAvailable={controller.webSearchToggleAvailable}
                      webSearchStatus={controller.webSearchStatus}
                      knowledgeEnabled={controller.knowledgeEnabled}
                      knowledgeStatus={controller.knowledgeStatus}
                      thinkingAvailable={controller.thinkingAvailable}
                      knowledgeAvailable={controller.knowledgeToggleAvailable}
                      onToggleWebSearch={() => controller.toggleWebSearch()}
                      onToggleKnowledge={() => controller.toggleKnowledge()}
                      onToggleThinking={() => controller.toggleThinking()}
                      activeSessionTitle={
                        controller.activeSession?.title ?? "New chat"
                      }
                      userDisplayName={
                        controller.settings?.user_display_name ?? ""
                      }
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
                  </div>
                ) : null}

                {activeView === "knowledge" ? (
                  <AppPageFrame
                    title="Knowledge"
                    isSidebarOpen={sidebarOpen}
                    onBackToChat={handleShowChat}
                    onToggleSidebar={handleToggleSidebar}
                  >
                    <Suspense
                      fallback={<PanelFallback label="Loading knowledge..." />}
                    >
                      <KnowledgePanel
                        status={controller.knowledgeStatus}
                        sources={controller.knowledgeSources}
                        stats={controller.knowledgeStats}
                        ingestProgress={controller.knowledgeIngestProgress}
                        onRefresh={() => controller.refreshKnowledge()}
                        onIngestFile={(filePath) =>
                          controller.ingestKnowledgeFile(filePath)
                        }
                        onIngestUrl={(url) =>
                          controller.ingestKnowledgeUrl(url)
                        }
                        onDeleteSource={(sourceId) =>
                          controller.deleteKnowledgeSource(sourceId)
                        }
                      />
                    </Suspense>
                  </AppPageFrame>
                ) : null}

                {activeView === "settings" ? (
                  <AppPageFrame
                    title="Settings"
                    isSidebarOpen={sidebarOpen}
                    onBackToChat={handleShowChat}
                    onToggleSidebar={handleToggleSidebar}
                  >
                    {readyForSettings ? (
                      <Suspense
                        fallback={<PanelFallback label="Loading settings..." />}
                      >
                        <SettingsPanel
                          settings={controller.settings!}
                          backendStatus={controller.backendStatus!}
                          activeModelId={controller.activeModelId}
                          isSwitchingModel={controller.isSwitchingModel}
                          onModelChange={(modelId) =>
                            controller.selectModel(modelId)
                          }
                          onSaveSettings={(input) =>
                            controller.saveAppSettings(input)
                          }
                          isSaving={controller.isSavingSettings}
                          isInstallingAppUpdate={
                            controller.isInstallingAppUpdate
                          }
                        />
                      </Suspense>
                    ) : (
                      <PanelFallback label="Loading settings..." />
                    )}
                  </AppPageFrame>
                ) : null}
              </>
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
        rootClassName="friday-sidebar-drawer"
        styles={{
          header: { display: "none" },
          body: { padding: 0, background: "var(--friday-surface)" },
        }}
      >
        <Sidebar
          sessions={controller.sessions}
          activeSessionId={controller.activeSession?.id ?? ""}
          activeView={activeView}
          isBusy={controller.isGenerating}
          onCreateSession={handleCreateSession}
          onSelectSession={handleSelectSession}
          onDeleteSession={(sessionId) =>
            void controller.deleteSession(sessionId)
          }
          onShowKnowledge={handleShowKnowledge}
          onShowSettings={handleShowSettings}
        />
      </Drawer>
    </ConfigProvider>
  );
}

function AppPageFrame({
  title,
  isSidebarOpen,
  onBackToChat,
  onToggleSidebar,
  children,
}: {
  title: string;
  isSidebarOpen: boolean;
  onBackToChat: () => void;
  onToggleSidebar: () => void;
  children: ReactNode;
}) {
  return (
    <div className="app-page">
      <div className="app-page__toolbar">
        <div className="app-page__toolbar-actions">
          <Button
            icon={<MenuOutlined />}
            onClick={onToggleSidebar}
            aria-label={isSidebarOpen ? "Hide sidebar" : "Show sidebar"}
            className="friday-icon-button"
          />
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={onBackToChat}
            className="secondary-action"
          >
            Back to chat
          </Button>
        </div>
        <Text type="secondary" className="app-page__toolbar-label">
          {title}
        </Text>
      </div>

      <div className="app-page__body">{children}</div>
    </div>
  );
}

function PanelFallback({ label }: { label: string }) {
  return (
    <div className="panel-fallback">
      <Spin size="large" />
      <Text type="secondary">{label}</Text>
    </div>
  );
}
