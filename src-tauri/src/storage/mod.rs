use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::Path;

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
    // Migration 001: Initial schema
    conn.execute_batch(include_str!("../../migrations/001_initial.sql"))
        .map_err(|e| format!("Migration 001 failed: {}", e))?;

    // Migration 002: RAG tables
    conn.execute_batch(include_str!("../../migrations/002_rag.sql"))
        .map_err(|e| format!("Migration 002 failed: {}", e))?;

    // Migration 003: Persist structured message content for multimodal rebuilds.
    match conn.execute_batch(include_str!(
        "../../migrations/003_message_content_parts.sql"
    )) {
        Ok(()) => {}
        Err(err)
            if err
                .to_string()
                .contains("duplicate column name: content_parts") => {}
        Err(err) => return Err(format!("Migration 003 failed: {}", err)),
    }

    tracing::info!("Database migrations applied successfully");
    Ok(())
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

pub fn load_json_setting<T>(conn: &Connection, key: &str) -> Result<Option<T>, String>
where
    T: DeserializeOwned,
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
