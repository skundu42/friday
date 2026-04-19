use crate::knowledge;
use crate::session::{Message, Session};
use crate::settings;
use crate::{ACTIVE_MODEL_KEY, CURRENT_SESSION_KEY};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::any::Any;
use std::path::Path;
use std::sync::{mpsc, Arc};
use std::time::Duration;

const MIGRATION_001_ID: &str = "001_initial";
const MIGRATION_003_ID: &str = "003_message_content_parts";
const MIGRATION_004_ID: &str = "004_knowledge";
const MIGRATION_005_ID: &str = "005_migration_ledger";
const MIGRATION_006_ID: &str = "006_audit_log_v2";

const MIGRATION_001_SQL: &str = include_str!("../../migrations/001_initial.sql");
const MIGRATION_003_SQL: &str = include_str!("../../migrations/003_message_content_parts.sql");
const MIGRATION_004_SQL: &str = include_str!("../../migrations/004_knowledge.sql");
const MIGRATION_005_SQL: &str = include_str!("../../migrations/005_migration_ledger.sql");
const MIGRATION_006_SQL: &str = include_str!("../../migrations/006_audit_log_v2.sql");
const DB_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
type MigrationHook = fn(&Connection) -> Result<(), String>;

/// Initialize SQLite database with migrations.
pub fn init_db(db_path: &Path) -> Result<Connection, String> {
    let conn = open_db_connection(db_path)?;

    // Run migrations
    run_migrations(&conn)?;

    Ok(conn)
}

fn open_db_connection(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open database: {}", e))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;
    conn.busy_timeout(DB_BUSY_TIMEOUT)
        .map_err(|e| format!("Failed to set busy timeout: {}", e))?;
    Ok(conn)
}

fn run_migrations(conn: &Connection) -> Result<(), String> {
    ensure_migration_ledger_table(conn)?;
    record_migration_if_missing(
        conn,
        MIGRATION_005_ID,
        migration_checksum(MIGRATION_005_SQL),
    )?;
    backfill_legacy_migration_ledger(conn)?;

    apply_migration(conn, MIGRATION_001_ID, MIGRATION_001_SQL, None)?;
    apply_migration(conn, MIGRATION_003_ID, MIGRATION_003_SQL, None)?;
    apply_migration(
        conn,
        MIGRATION_004_ID,
        MIGRATION_004_SQL,
        Some(archive_legacy_rag_tables),
    )?;
    apply_migration(conn, MIGRATION_006_ID, MIGRATION_006_SQL, None)?;

    tracing::info!("Database migrations applied successfully");
    Ok(())
}

fn ensure_migration_ledger_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(MIGRATION_005_SQL)
        .map_err(|e| format!("Migration 005 failed: {}", e))
}

fn migration_checksum(sql: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(sql.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn record_migration_if_missing(
    conn: &Connection,
    migration_id: &str,
    checksum: String,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO migration_ledger (migration_id, checksum, applied_at)
         VALUES (?1, ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(migration_id) DO NOTHING",
        params![migration_id, checksum],
    )
    .map_err(|e| format!("Failed to record migration {}: {}", migration_id, e))?;
    Ok(())
}

fn migration_applied(conn: &Connection, migration_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM migration_ledger WHERE migration_id = ?1 LIMIT 1",
        [migration_id],
        |_| Ok(()),
    )
    .optional()
    .map(|result| result.is_some())
    .map_err(|e| format!("Failed to inspect migration {}: {}", migration_id, e))
}

fn apply_migration(
    conn: &Connection,
    migration_id: &str,
    migration_sql: &str,
    post_apply: Option<MigrationHook>,
) -> Result<(), String> {
    if migration_applied(conn, migration_id)? {
        return Ok(());
    }

    conn.execute_batch("BEGIN IMMEDIATE TRANSACTION;")
        .map_err(|e| {
            format!(
                "Failed to begin migration transaction {}: {}",
                migration_id, e
            )
        })?;

    let result = (|| {
        conn.execute_batch(migration_sql)
            .map_err(|e| format!("Migration {} failed: {}", migration_id, e))?;
        if let Some(hook) = post_apply {
            hook(conn)?;
        }
        record_migration_if_missing(conn, migration_id, migration_checksum(migration_sql))?;
        Ok::<(), String>(())
    })();

    match result {
        Ok(()) => conn
            .execute_batch("COMMIT;")
            .map_err(|e| {
                let _ = conn.execute_batch("ROLLBACK;");
                format!(
                    "Failed to commit migration transaction {}: {}",
                    migration_id, e
                )
            })
            .map(|_| ()),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

fn backfill_legacy_migration_ledger(conn: &Connection) -> Result<(), String> {
    if has_table(conn, "sessions")?
        && has_table(conn, "messages")?
        && has_table(conn, "audit_log")?
        && has_table(conn, "workspace_memory")?
        && has_table(conn, "settings")?
    {
        record_migration_if_missing(
            conn,
            MIGRATION_001_ID,
            migration_checksum(MIGRATION_001_SQL),
        )?;
    }

    if has_column(conn, "messages", "content_parts")? {
        record_migration_if_missing(
            conn,
            MIGRATION_003_ID,
            migration_checksum(MIGRATION_003_SQL),
        )?;
    }

    if has_table(conn, "knowledge_sources")? && has_table(conn, "legacy_rag_archive_log")? {
        record_migration_if_missing(
            conn,
            MIGRATION_004_ID,
            migration_checksum(MIGRATION_004_SQL),
        )?;
    }

    if has_column(conn, "audit_log", "request_id")?
        && has_column(conn, "audit_log", "failure_stage")?
        && has_column(conn, "audit_log", "attachment_count")?
        && has_column(conn, "audit_log", "cancelled")?
        && has_column(conn, "audit_log", "web_assist_enabled")?
        && has_column(conn, "audit_log", "knowledge_enabled")?
        && has_column(conn, "audit_log", "thinking_enabled")?
    {
        record_migration_if_missing(
            conn,
            MIGRATION_006_ID,
            migration_checksum(MIGRATION_006_SQL),
        )?;
    }

    Ok(())
}

fn archive_legacy_rag_tables(conn: &Connection) -> Result<(), String> {
    for legacy_table in ["rag_documents", "rag_chunks"] {
        if !has_table(conn, legacy_table)? {
            continue;
        }

        let archive_table = format!("{}_legacy_archive", legacy_table);
        if !has_table(conn, &archive_table)? {
            let archive_sql = format!(
                "CREATE TABLE \"{}\" AS SELECT * FROM \"{}\"",
                escape_identifier(&archive_table),
                escape_identifier(legacy_table),
            );
            conn.execute_batch(&archive_sql).map_err(|e| {
                format!(
                    "Failed to archive legacy table {} into {}: {}",
                    legacy_table, archive_table, e
                )
            })?;
        }

        conn.execute(
            "INSERT INTO legacy_rag_archive_log (source_table, archive_table, archived_at)
             VALUES (?1, ?2, CURRENT_TIMESTAMP)
             ON CONFLICT(source_table) DO UPDATE SET
                archive_table = excluded.archive_table,
                archived_at = excluded.archived_at",
            params![legacy_table, archive_table],
        )
        .map_err(|e| {
            format!(
                "Failed to record archive for legacy table {}: {}",
                legacy_table, e
            )
        })?;
    }

    Ok(())
}

fn has_table(conn: &Connection, table_name: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        [table_name],
        |_| Ok(()),
    )
    .optional()
    .map(|result| result.is_some())
    .map_err(|e| format!("Failed to inspect table {}: {}", table_name, e))
}

fn has_column(conn: &Connection, table_name: &str, column_name: &str) -> Result<bool, String> {
    let sql = format!(
        "SELECT 1 FROM pragma_table_info('{}') WHERE name = ?1 LIMIT 1",
        table_name.replace('\'', "''"),
    );
    conn.query_row(&sql, [column_name], |_| Ok(()))
        .optional()
        .map(|result| result.is_some())
        .map_err(|e| {
            format!(
                "Failed to inspect column {}.{}: {}",
                table_name, column_name, e
            )
        })
}

fn escape_identifier(identifier: &str) -> String {
    identifier.replace('"', "\"\"")
}

pub fn load_string_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(|e| format!("Failed to prepare setting lookup: {}", e))?;

    match stmt.query_row([key], |row| row.get::<_, String>(0)) {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(format!("Failed to load setting {}: {}", key, err)),
    }
}

pub fn save_string_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
        rusqlite::params![key, value],
    )
    .map_err(|e| format!("Failed to save setting {}: {}", key, e))?;

    Ok(())
}

#[cfg(test)]
pub fn load_json_setting<T>(conn: &Connection, key: &str) -> Result<Option<T>, String>
where
    T: serde::de::DeserializeOwned,
{
    let Some(value) = load_string_setting(conn, key)? else {
        return Ok(None);
    };

    serde_json::from_str(&value)
        .map(Some)
        .map_err(|e| format!("Failed to deserialize setting {}: {}", key, e))
}

pub fn save_json_setting<T>(conn: &Connection, key: &str, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    let payload = serde_json::to_string(value)
        .map_err(|e| format!("Failed to serialize setting {}: {}", key, e))?;

    save_string_setting(conn, key, &payload)
}

type WriteResponse = Result<Box<dyn Any + Send>, String>;
type WriteOperation = Box<dyn FnOnce(&Connection) -> WriteResponse + Send + 'static>;

struct WriteRequest {
    operation: WriteOperation,
    reply: mpsc::Sender<WriteResponse>,
}

#[derive(Clone)]
pub struct DatabaseHandle {
    db_path: Arc<std::path::PathBuf>,
    write_tx: mpsc::Sender<WriteRequest>,
}

#[derive(Debug, Clone)]
pub struct PersistMessageJson {
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub content_parts: Option<serde_json::Value>,
    pub model_used: Option<String>,
    pub latency_ms: Option<i64>,
    pub title_source: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AuditLogStart {
    pub request_id: String,
    pub session_id: String,
    pub user_message: String,
    pub model_used: Option<String>,
    pub attachment_count: usize,
    pub web_assist_enabled: bool,
    pub knowledge_enabled: bool,
    pub thinking_enabled: bool,
}

#[derive(Debug, Clone, Default)]
pub struct AuditLogFinish {
    pub request_id: String,
    pub model_used: Option<String>,
    pub failure_stage: Option<String>,
    pub tools_called: Option<String>,
    pub web_urls_fetched: Option<String>,
    pub rag_sources: Option<String>,
    pub rag_chunks_retrieved: Option<i64>,
    pub response_latency_ms: Option<i64>,
    pub error: Option<String>,
    pub cancelled: bool,
}

impl DatabaseHandle {
    pub fn new(db_path: &Path) -> Result<Self, String> {
        let writer_connection = init_db(db_path)?;
        let (write_tx, write_rx) = mpsc::channel::<WriteRequest>();
        std::thread::Builder::new()
            .name("friday-db-writer".to_string())
            .spawn(move || {
                while let Ok(request) = write_rx.recv() {
                    let result = (request.operation)(&writer_connection);
                    let _ = request.reply.send(result);
                }
            })
            .map_err(|error| format!("Failed to start database writer thread: {}", error))?;

        Ok(Self {
            db_path: Arc::new(db_path.to_path_buf()),
            write_tx,
        })
    }

    pub fn path(&self) -> &Path {
        self.db_path.as_ref()
    }

    pub fn read<T, F>(&self, operation: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        let connection = open_db_connection(self.path())?;
        operation(&connection)
    }

    pub fn write<T, F>(&self, operation: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, String> + Send + 'static,
    {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.write_tx
            .send(WriteRequest {
                operation: Box::new(move |conn| {
                    operation(conn).map(|value| Box::new(value) as Box<dyn Any + Send>)
                }),
                reply: reply_tx,
            })
            .map_err(|_| "Database writer is unavailable.".to_string())?;

        match reply_rx
            .recv()
            .map_err(|_| "Database writer stopped unexpectedly.".to_string())?
        {
            Ok(value) => value
                .downcast::<T>()
                .map(|boxed| *boxed)
                .map_err(|_| "Database writer returned an unexpected response type.".to_string()),
            Err(error) => Err(error),
        }
    }

    pub fn load_app_settings(&self) -> Result<settings::AppSettings, String> {
        self.read(settings::load_settings)
    }

    pub fn save_app_settings(
        &self,
        input: settings::AppSettingsInput,
    ) -> Result<settings::AppSettings, String> {
        self.write(move |conn| settings::save_settings(conn, &input))
    }

    pub fn load_string_setting(&self, key: &str) -> Result<Option<String>, String> {
        let key = key.to_string();
        self.read(move |conn| load_string_setting(conn, &key))
    }

    pub fn save_string_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let key = key.to_string();
        let value = value.to_string();
        self.write(move |conn| save_string_setting(conn, &key, &value))
    }

    pub fn list_sessions(&self) -> Result<Vec<Session>, String> {
        self.read(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC",
                )
                .map_err(|e| e.to_string())?;
            let sessions = stmt
                .query_map([], session_from_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(sessions)
        })
    }

    pub fn load_session(&self, session_id: &str) -> Result<Session, String> {
        let session_id = session_id.to_string();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?1 LIMIT 1",
                )
                .map_err(|e| e.to_string())?;

            stmt.query_row([session_id], session_from_row)
                .map_err(|error| match error {
                    rusqlite::Error::QueryReturnedNoRows => "Session not found".to_string(),
                    other => format!("Failed to load session: {}", other),
                })
        })
    }

    pub fn load_messages(&self, session_id: &str) -> Result<Vec<Message>, String> {
        let session_id = session_id.to_string();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare("SELECT id, session_id, role, content, content_parts, model_used, tokens_used, latency_ms, created_at FROM messages WHERE session_id = ?1 ORDER BY created_at ASC")
                .map_err(|e| e.to_string())?;
            let messages = stmt
                .query_map([session_id], message_from_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(messages)
        })
    }

    pub fn load_recent_messages(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<Message>, String> {
        let session_id = session_id.to_string();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, session_id, role, content, content_parts, model_used, tokens_used, latency_ms, created_at
                     FROM messages
                     WHERE session_id = ?1
                     ORDER BY created_at DESC
                     LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let mut messages = stmt
                .query_map(params![session_id, limit as i64], message_from_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            messages.reverse();
            Ok(messages)
        })
    }

    pub fn create_session(&self, title: &str) -> Result<Session, String> {
        let title = title.to_string();
        self.write(move |conn| {
            let id = uuid::Uuid::new_v4().to_string();
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, title, now, now],
            )
            .map_err(|e| e.to_string())?;

            Ok(Session {
                id,
                title,
                created_at: now.clone(),
                updated_at: now,
            })
        })
    }

    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        let session_id = session_id.to_string();
        self.write(move |conn| {
            conn.execute_batch("BEGIN IMMEDIATE TRANSACTION;")
                .map_err(|e| e.to_string())?;

            let result = (|| {
                conn.execute(
                    "DELETE FROM messages WHERE session_id = ?1",
                    params![session_id],
                )?;
                conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
                Ok::<(), rusqlite::Error>(())
            })();

            match result {
                Ok(()) => conn.execute_batch("COMMIT;").map_err(|e| {
                    let _ = conn.execute_batch("ROLLBACK;");
                    e.to_string()
                }),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK;");
                    Err(error.to_string())
                }
            }
        })
    }

    pub fn list_knowledge_sources(&self) -> Result<Vec<knowledge::KnowledgeSource>, String> {
        self.read(knowledge::list_sources)
    }

    pub fn load_active_model_id(&self) -> Result<Option<String>, String> {
        self.load_string_setting(ACTIVE_MODEL_KEY)
    }

    pub fn save_active_model_id(&self, model_id: &str) -> Result<(), String> {
        self.save_string_setting(ACTIVE_MODEL_KEY, model_id)
    }

    pub fn load_current_session_id(&self) -> Result<Option<String>, String> {
        self.load_string_setting(CURRENT_SESSION_KEY)
    }

    pub fn save_current_session_id(&self, session_id: &str) -> Result<(), String> {
        self.save_string_setting(CURRENT_SESSION_KEY, session_id)
    }

    pub fn save_message_json(&self, params: PersistMessageJson) -> Result<(), String> {
        self.write(move |conn| save_message_json_conn(conn, params))
    }

    pub fn insert_audit_log(&self, start: AuditLogStart) -> Result<(), String> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO audit_log (
                    request_id,
                    session_id,
                    user_message,
                    model_used,
                    attachment_count,
                    cancelled,
                    web_assist_enabled,
                    knowledge_enabled,
                    thinking_enabled
                ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8)",
                params![
                    start.request_id,
                    start.session_id,
                    start.user_message,
                    start.model_used,
                    start.attachment_count as i64,
                    bool_to_sqlite(start.web_assist_enabled),
                    bool_to_sqlite(start.knowledge_enabled),
                    bool_to_sqlite(start.thinking_enabled),
                ],
            )
            .map_err(|e| format!("Failed to insert audit log row: {}", e))?;
            Ok(())
        })
    }

    pub fn finish_audit_log(&self, finish: AuditLogFinish) -> Result<(), String> {
        self.write(move |conn| {
            let updated_rows = conn
                .execute(
                    "UPDATE audit_log
                     SET model_used = COALESCE(?2, model_used),
                         failure_stage = ?3,
                         tools_called = ?4,
                         web_urls_fetched = ?5,
                         rag_sources = ?6,
                         rag_chunks_retrieved = ?7,
                         response_latency_ms = ?8,
                         error = ?9,
                         cancelled = ?10
                     WHERE request_id = ?1",
                    params![
                        finish.request_id,
                        finish.model_used,
                        finish.failure_stage,
                        finish.tools_called,
                        finish.web_urls_fetched,
                        finish.rag_sources,
                        finish.rag_chunks_retrieved,
                        finish.response_latency_ms,
                        finish.error,
                        bool_to_sqlite(finish.cancelled),
                    ],
                )
                .map_err(|e| format!("Failed to update audit log row: {}", e))?;

            if updated_rows == 0 {
                return Err("Audit log row not found for request.".to_string());
            }

            Ok(())
        })
    }
}

fn bool_to_sqlite(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn parse_message_content_parts(raw: Option<String>) -> Option<serde_json::Value> {
    match raw {
        Some(payload) if !payload.trim().is_empty() => serde_json::from_str(&payload).ok(),
        _ => None,
    }
}

fn message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    let raw_parts: Option<String> = row.get(4)?;
    Ok(Message {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        content_parts: parse_message_content_parts(raw_parts),
        model_used: row.get(5)?,
        tokens_used: row.get(6)?,
        latency_ms: row.get(7)?,
        created_at: row.get(8)?,
    })
}

fn session_title_candidate(input: &str) -> Option<String> {
    let first_line = input.lines().map(str::trim).find(|line| !line.is_empty())?;
    let collapsed = first_line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }

    const SESSION_TITLE_PREVIEW_CHARS: usize = 48;
    let title: String = collapsed
        .chars()
        .take(SESSION_TITLE_PREVIEW_CHARS)
        .collect();
    if collapsed.chars().count() > SESSION_TITLE_PREVIEW_CHARS {
        Some(format!("{}…", title))
    } else {
        Some(title)
    }
}

fn save_message_json_conn(conn: &Connection, params: PersistMessageJson) -> Result<(), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let serialized_parts = params
        .content_parts
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| format!("Failed to serialize message content parts: {}", e))?;
    let title_candidate = if params.role == "user" {
        session_title_candidate(
            params
                .title_source
                .as_deref()
                .unwrap_or(params.content.as_str()),
        )
    } else {
        None
    };

    conn.execute_batch("BEGIN IMMEDIATE TRANSACTION;")
        .map_err(|e| e.to_string())?;

    let result = (|| {
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, content_parts, model_used, latency_ms, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                params.session_id,
                params.role,
                params.content,
                serialized_parts,
                params.model_used,
                params.latency_ms,
                now
            ],
        )
        .map_err(|e| e.to_string())?;

        if let Some(title) = title_candidate {
            conn.execute(
                "UPDATE sessions
                 SET title = CASE WHEN title = ?1 THEN ?2 ELSE title END,
                     updated_at = ?3
                 WHERE id = ?4",
                params!["New chat", title, now, params.session_id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
                params![now, params.session_id],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok::<(), String>(())
    })();

    match result {
        Ok(()) => conn.execute_batch("COMMIT;").map_err(|e| {
            let _ = conn.execute_batch("ROLLBACK;");
            e.to_string()
        }),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_db_init() {
        let dir = std::env::temp_dir().join("friday_test_db");
        std::fs::create_dir_all(&dir).ok();
        let db_path = dir.join("test.db");
        let conn = init_db(&db_path).unwrap();

        // Verify tables exist
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(tables.contains(&"sessions".to_string()));
        assert!(tables.contains(&"messages".to_string()));
        assert!(tables.contains(&"audit_log".to_string()));
        assert!(tables.contains(&"workspace_memory".to_string()));
        assert!(tables.contains(&"settings".to_string()));
        assert!(tables.contains(&"migration_ledger".to_string()));
        assert!(tables.contains(&"knowledge_sources".to_string()));
        assert!(tables.contains(&"legacy_rag_archive_log".to_string()));
        assert!(!tables.contains(&"rag_documents".to_string()));
        assert!(!tables.contains(&"rag_chunks".to_string()));
    }

    #[test]
    fn test_migration_ledger_records_applied_migrations() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let mut stmt = conn
            .prepare("SELECT migration_id FROM migration_ledger ORDER BY migration_id")
            .unwrap();
        let applied_ids: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|row| row.ok())
            .collect();

        assert_eq!(
            applied_ids,
            vec![
                MIGRATION_001_ID.to_string(),
                MIGRATION_003_ID.to_string(),
                MIGRATION_004_ID.to_string(),
                MIGRATION_005_ID.to_string(),
                MIGRATION_006_ID.to_string(),
            ]
        );
    }

    #[test]
    fn test_legacy_rag_tables_are_archived_non_destructively() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_001_SQL).unwrap();
        conn.execute_batch(MIGRATION_003_SQL).unwrap();
        conn.execute_batch(
            "CREATE TABLE rag_documents (id TEXT PRIMARY KEY, title TEXT NOT NULL);
             CREATE TABLE rag_chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, content TEXT NOT NULL);
             INSERT INTO rag_documents (id, title) VALUES ('doc-1', 'legacy');
             INSERT INTO rag_chunks (id, document_id, content) VALUES ('chunk-1', 'doc-1', 'legacy chunk');",
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let rag_documents_exists = has_table(&conn, "rag_documents").unwrap();
        let rag_chunks_exists = has_table(&conn, "rag_chunks").unwrap();
        let rag_documents_archive_exists =
            has_table(&conn, "rag_documents_legacy_archive").unwrap();
        let rag_chunks_archive_exists = has_table(&conn, "rag_chunks_legacy_archive").unwrap();

        assert!(rag_documents_exists);
        assert!(rag_chunks_exists);
        assert!(rag_documents_archive_exists);
        assert!(rag_chunks_archive_exists);

        let archived_docs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rag_documents_legacy_archive",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let archived_chunks: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM rag_chunks_legacy_archive",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(archived_docs, 1);
        assert_eq!(archived_chunks, 1);
    }

    #[test]
    fn test_setting_round_trip() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        save_string_setting(&conn, "current_session", "session-123").unwrap();
        let loaded = load_string_setting(&conn, "current_session").unwrap();

        assert_eq!(loaded.as_deref(), Some("session-123"));
    }

    #[test]
    fn test_json_setting_round_trip() {
        #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
        struct TestSettings {
            enabled: bool,
            model: String,
        }

        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let input = TestSettings {
            enabled: true,
            model: "gemma3:4b".to_string(),
        };

        save_json_setting(&conn, "app_settings", &input).unwrap();
        let loaded: Option<TestSettings> = load_json_setting(&conn, "app_settings").unwrap();

        assert_eq!(loaded, Some(input));
    }

    #[test]
    fn audit_log_v2_columns_are_available_after_migration() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        for column in [
            "request_id",
            "failure_stage",
            "attachment_count",
            "cancelled",
            "web_assist_enabled",
            "knowledge_enabled",
            "thinking_enabled",
        ] {
            assert!(has_column(&conn, "audit_log", column).unwrap());
        }
    }

    #[test]
    fn database_handle_serializes_writes_and_supports_reads() {
        let temp_root =
            std::env::temp_dir().join(format!("friday-db-handle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp_root).unwrap();
        let db_path = temp_root.join("friday.db");
        let handle = DatabaseHandle::new(&db_path).unwrap();

        handle
            .save_string_setting("current_session", "session-a")
            .unwrap();
        let loaded = handle.load_string_setting("current_session").unwrap();
        assert_eq!(loaded.as_deref(), Some("session-a"));

        let created = handle.create_session("New chat").unwrap();
        let sessions = handle.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, created.id);

        let _ = std::fs::remove_dir_all(temp_root);
    }
}
