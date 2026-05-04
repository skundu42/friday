import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dropdown, Input, Typography } from "antd";
import type { InputRef } from "antd";
import {
  DatabaseOutlined,
  DeleteOutlined,
  EllipsisOutlined,
  MessageOutlined,
  PlusOutlined,
  SearchOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import type { Session } from "../types";
import AppLogo from "./AppLogo";

const { Text, Title } = Typography;

type SessionBucket = "today" | "yesterday" | "week" | "older";

const BUCKET_LABELS: Record<SessionBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Last 7 days",
  older: "Older",
};

const BUCKET_ORDER: SessionBucket[] = ["today", "yesterday", "week", "older"];

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
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<InputRef>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const isModifier = event.metaKey || event.ctrlKey;
      if (isModifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  const confirmDelete = (session: Session) => {
    if (!window.confirm(`Delete "${session.title}"?`)) return;
    onDeleteSession(session.id);
  };

  const filteredSessions = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(trimmed));
  }, [sessions, query]);

  const grouped = useMemo(() => groupSessionsByDate(filteredSessions), [
    filteredSessions,
  ]);

  const totalShown = filteredSessions.length;
  const isFiltered = query.trim().length > 0;

  return (
    <div className="sidebar-shell">
      <div className="sidebar-window-drag-region" data-tauri-drag-region />
      <div className="sidebar-brand">
        <AppLogo size={46} />
        <div className="sidebar-brand__copy">
          <Title level={5} className="sidebar-brand__title">
            Friday
          </Title>
          <Text className="sidebar-brand__subtitle">Local AI workspace</Text>
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

      {sessions.length > 0 ? (
        <div className="sidebar-search">
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                (event.target as HTMLInputElement).blur();
              }
            }}
            allowClear
            prefix={<SearchOutlined className="sidebar-search__icon" />}
            placeholder="Search chats"
            aria-label="Search chats"
            className="sidebar-search__input"
          />
          <kbd className="sidebar-search__hint" aria-hidden="true">
            ⌘K
          </kbd>
        </div>
      ) : null}

      <div className="sidebar-section">
        <div className="sidebar-section__head">
          <span className="sidebar-section__label">
            {isFiltered ? "Results" : "Recent Chats"}
          </span>
          <span className="sidebar-section__count">{totalShown}</span>
        </div>

        <div className="sidebar-session-list">
          {sessions.length === 0 ? (
            <div className="sidebar-empty">
              <div className="sidebar-empty__art" aria-hidden="true">
                <AppLogo size={40} />
              </div>
              <Text strong className="sidebar-empty__title">
                Start your first chat
              </Text>
              <Text className="sidebar-empty__body">
                Conversations you start will appear here.
              </Text>
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={onCreateSession}
                disabled={isBusy}
                className="sidebar-empty__cta"
              >
                New chat
              </Button>
            </div>
          ) : totalShown === 0 ? (
            <div className="sidebar-empty sidebar-empty--filtered">
              <Text className="sidebar-empty__body">
                No chats matching "{query.trim()}"
              </Text>
              <Button
                size="small"
                type="text"
                onClick={() => setQuery("")}
                className="sidebar-empty__cta"
              >
                Clear search
              </Button>
            </div>
          ) : (
            BUCKET_ORDER.flatMap((bucket) => {
              const items = grouped[bucket];
              if (!items || items.length === 0) return [];

              return [
                <div className="sidebar-group" key={bucket}>
                  <div className="sidebar-group__label">
                    {BUCKET_LABELS[bucket]}
                  </div>
                  {items.map((session) => {
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
                  })}
                </div>,
              ];
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

function bucketForSession(value: string): SessionBucket {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "older";

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

  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return "week";
  return "older";
}

function groupSessionsByDate(
  sessions: Session[],
): Record<SessionBucket, Session[]> {
  const groups: Record<SessionBucket, Session[]> = {
    today: [],
    yesterday: [],
    week: [],
    older: [],
  };
  for (const session of sessions) {
    groups[bucketForSession(session.updated_at)].push(session);
  }
  return groups;
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
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (diffDays === 1) {
    return "Yesterday";
  }
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }

  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}
