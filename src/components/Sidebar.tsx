import { Avatar, Button, Divider, Dropdown, List, Typography } from "antd";
import {
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
  isBusy?: boolean;
  onCreateSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onShowSettings: () => void;
}

export default function Sidebar({
  sessions,
  activeSessionId,
  isBusy = false,
  onCreateSession,
  onSelectSession,
  onDeleteSession,
  onShowSettings,
}: SidebarProps) {
  const confirmDelete = (session: Session) => {
    if (!window.confirm(`Delete "${session.title}"?`)) return;
    onDeleteSession(session.id);
  };

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: 16,
        gap: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 0",
        }}
      >
        <AppLogo size={44} />
        <div>
          <Title level={5} style={{ margin: 0 }}>
            Friday
          </Title>
          <Text type="secondary" style={{ fontSize: 11 }}>
            Local-first desktop assistant
          </Text>
        </div>
      </div>

      <Button
        type="primary"
        icon={<PlusOutlined />}
        block
        onClick={onCreateSession}
        disabled={isBusy}
        style={{
          height: 44,
          border: "2px solid #2C2C2C",
          boxShadow: "3px 3px 0 #2C2C2C",
          background: "#52C41A",
        }}
      >
        New Chat
      </Button>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <Text
            type="secondary"
            style={{ fontSize: 11, textTransform: "uppercase", fontWeight: 700 }}
          >
            Recent Chats
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {sessions.length}
          </Text>
        </div>

        <div style={{ flex: 1, overflowY: "auto" }}>
          <List
            dataSource={sessions}
            renderItem={(session) => {
              const isActive = session.id === activeSessionId;
              return (
                <List.Item
                  onClick={() => {
                    if (isBusy) return;
                    onSelectSession(session.id);
                  }}
                  style={{
                    cursor: isBusy ? "not-allowed" : "pointer",
                    borderRadius: 14,
                    padding: "10px 12px",
                    marginBottom: 8,
                    background: isActive ? "#FFF0F6" : "#FFFFFF",
                    border: isActive
                      ? "3px solid #2C2C2C"
                      : "2px solid #E8E8E8",
                    boxShadow: isActive ? "3px 3px 0 #2C2C2C" : "none",
                    alignItems: "flex-start",
                  }}
                  extra={
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
                        disabled={isBusy}
                        aria-label={`More actions for ${session.title}`}
                      />
                    </Dropdown>
                  }
                >
                  <List.Item.Meta
                    avatar={
                      <Avatar
                        size={32}
                        icon={<MessageOutlined />}
                        style={{
                          background: isActive ? "#52C41A" : "#FFF9F0",
                          color: "#2C2C2C",
                          border: "2px solid #2C2C2C",
                          marginTop: 2,
                        }}
                      />
                    }
                    title={
                      <Text
                        strong
                        style={{
                          display: "block",
                          fontSize: 13,
                          lineHeight: 1.35,
                        }}
                      >
                        {session.title}
                      </Text>
                    }
                    description={
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {formatRelativeSessionTime(session.updated_at)}
                      </Text>
                    }
                  />
                </List.Item>
              );
            }}
          />

          {sessions.length === 0 ? (
            <Text
              type="secondary"
              style={{
                fontSize: 12,
                display: "block",
                textAlign: "center",
                marginTop: 20,
              }}
            >
              No conversations yet
            </Text>
          ) : null}
        </div>
      </div>

      <Divider style={{ margin: 0 }} />
      <Button
        icon={<SettingOutlined />}
        block
        onClick={onShowSettings}
        disabled={isBusy}
        aria-label="Open settings"
        style={{ height: 40 }}
      >
        Settings
      </Button>
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
