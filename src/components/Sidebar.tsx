import { Button, Dropdown, Typography } from "antd";
import {
  DatabaseOutlined,
  DeleteOutlined,
  EllipsisOutlined,
  MessageOutlined,
  PlusOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import type { Session } from "../types";
import AppLogo from "./AppLogo";

const { Text, Title } = Typography;

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string;
  activeView?: "chat" | "knowledge" | "settings";
  isBusy?: boolean;
  onCreateSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onShowKnowledge: () => void;
  onShowSettings: () => void;
}

export default function Sidebar({
  sessions,
  activeSessionId,
  activeView = "chat",
  isBusy = false,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onShowKnowledge,
  onShowSettings,
}: SidebarProps) {
  const confirmDelete = (session: Session) => {
    if (!window.confirm(`Delete "${session.title}"?`)) return;
    onDeleteSession(session.id);
  };

  return (
    <div className="sidebar-shell">
      <div className="sidebar-window-drag-region" data-tauri-drag-region />
      <div className="sidebar-brand">
        <AppLogo size={46} />
        <div className="sidebar-brand__copy">
          <Title level={5} className="sidebar-brand__title">
            Friday
          </Title>
          <Text className="sidebar-brand__subtitle">
            Local AI workspace
          </Text>
        </div>
      </div>

      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={onCreateSession}
        disabled={isBusy}
        className="primary-action sidebar-primary"
      >
        New Chat
      </Button>

      <div className="sidebar-section">
        <div className="sidebar-section__head">
          <span className="sidebar-section__label">Recent Chats</span>
          <span className="sidebar-section__count">{sessions.length}</span>
        </div>

        <div className="sidebar-session-list">
          {sessions.length === 0 ? (
            <div className="sidebar-empty">No conversations yet</div>
          ) : (
            sessions.map((session) => {
              const isActive = session.id === activeSessionId;

              return (
                <div
                  key={session.id}
                  className={`session-item${isActive ? " is-active" : ""}${isBusy ? " is-disabled" : ""}`}
                  onClick={() => {
                    if (isBusy) return;
                    onSelectSession(session.id);
                  }}
                  role="button"
                  tabIndex={isBusy ? -1 : 0}
                  onKeyDown={(event) => {
                    if (isBusy) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectSession(session.id);
                    }
                  }}
                  aria-current={isActive ? "page" : undefined}
                >
                  <div className="session-item__body">
                    <span className="session-item__icon">
                      <MessageOutlined />
                    </span>
                    <div className="session-item__copy">
                      <Text strong className="session-item__title">
                        {session.title}
                      </Text>
                      <Text className="session-item__timestamp">
                        {formatRelativeSessionTime(session.updated_at)}
                      </Text>
                    </div>
                  </div>

                  <Dropdown
                    trigger={["click"]}
                    menu={{
                      items: [
                        {
                          key: "delete",
                          icon: <DeleteOutlined />,
                          danger: true,
                          label: "Delete chat",
                          onClick: () => confirmDelete(session),
                        },
                      ],
                    }}
                  >
                    <Button
                      type="text"
                      size="small"
                      icon={<EllipsisOutlined />}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.stopPropagation();
                        }
                      }}
                      disabled={isBusy}
                      aria-label={`More actions for ${session.title}`}
                      className="session-item__menu"
                    />
                  </Dropdown>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <Button
          icon={<DatabaseOutlined />}
          onClick={onShowKnowledge}
          disabled={isBusy}
          aria-label="Open knowledge"
          aria-pressed={activeView === "knowledge"}
          className={`sidebar-footer-button${activeView === "knowledge" ? " is-active" : ""}`}
        >
          Knowledge
        </Button>
        <Button
          icon={<SettingOutlined />}
          onClick={onShowSettings}
          disabled={isBusy}
          aria-label="Open settings"
          aria-pressed={activeView === "settings"}
          className={`sidebar-footer-button${activeView === "settings" ? " is-active" : ""}`}
        >
          Settings
        </Button>
      </div>
    </div>
  );
}

function formatRelativeSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfTarget.getTime()) / (24 * 60 * 60 * 1000),
  );

  if (diffDays === 0) {
    return "Today";
  }
  if (diffDays === 1) {
    return "Yesterday";
  }

  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}
