use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;

const MIGRATION_001_ID: &str = "001_initial";
const MIGRATION_003_ID: &str = "003_message_content_parts";
const MIGRATION_004_ID: &str = "004_knowledge";
const MIGRATION_005_ID: &str = "005_migration_ledger";

const MIGRATION_001_SQL: &str = include_str!("../../migrations/001_initial.sql");
const MIGRATION_003_SQL: &str = include_str!("../../migrations/003_message_content_parts.sql");
const MIGRATION_004_SQL: &str = include_str!("../../migrations/004_knowledge.sql");
const MIGRATION_005_SQL: &str = include_str!("../../migrations/005_migration_ledger.sql");
type MigrationHook = fn(&Connection) -> Result<(), String>;

/// Initialize SQLite database with migrations.
pub fn init_db(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open database: {}", e))?;

    // Enable WAL mode for better concurrent performance
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("Failed to set pragmas: {}", e))?;

    // Run migrations
    run_migrations(&conn)?;

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
}
