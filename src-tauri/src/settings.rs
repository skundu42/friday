use crate::storage;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sysinfo::System;

const APP_SETTINGS_KEY: &str = "app_settings";
pub const DEFAULT_MAX_TOKENS: u32 = 4096;
pub const HIGH_RAM_DEFAULT_MAX_TOKENS: u32 = 16384;
pub const MIN_MAX_TOKENS: u32 = 1024;
pub const MAX_MAX_TOKENS: u32 = 131072;
const DEFAULT_THEME_MODE: &str = "light";
pub const DEFAULT_SPECULATIVE_DECODING: SpeculativeDecodingMode = SpeculativeDecodingMode::Auto;
const SUPPORTED_REPLY_LANGUAGES: &[&str] = &[
    "english",
    "hindi",
    "bengali",
    "marathi",
    "tamil",
    "punjabi",
    "spanish",
    "french",
    "mandarin",
    "portuguese",
    "japanese",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppSettings {
    pub auto_start_backend: bool,
    pub auto_download_updates: bool,
    pub user_display_name: String,
    pub theme_mode: String,
    pub chat: ChatSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ChatSettings {
    pub reply_language: String,
    pub max_tokens: u32,
    pub web_assist_enabled: bool,
    pub knowledge_enabled: bool,
    pub generation: GenerationSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppSettingsInput {
    pub auto_start_backend: bool,
    pub auto_download_updates: bool,
    pub user_display_name: String,
    pub theme_mode: String,
    pub chat: ChatSettingsInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ChatSettingsInput {
    pub reply_language: String,
    pub max_tokens: u32,
    pub web_assist_enabled: bool,
    pub knowledge_enabled: bool,
    pub generation: GenerationSettingsInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct GenerationSettings {
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub thinking_enabled: Option<bool>,
    pub speculative_decoding: SpeculativeDecodingMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct GenerationSettingsInput {
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub thinking_enabled: Option<bool>,
    pub speculative_decoding: SpeculativeDecodingMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GenerationRequestConfig {
    pub max_output_tokens: u32,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub thinking_enabled: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SpeculativeDecodingMode {
    #[default]
    Auto,
    Enabled,
    Disabled,
}

impl SpeculativeDecodingMode {
    pub fn engine_value(self) -> Option<bool> {
        match self {
            Self::Auto => None,
            Self::Enabled => Some(true),
            Self::Disabled => Some(false),
        }
    }
}

fn deserialize_speculative_decoding_lossy<'de, D>(
    deserializer: D,
) -> Result<SpeculativeDecodingMode, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match value.as_ref().and_then(serde_json::Value::as_str) {
        Some("enabled") => SpeculativeDecodingMode::Enabled,
        Some("disabled") => SpeculativeDecodingMode::Disabled,
        _ => DEFAULT_SPECULATIVE_DECODING,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
struct StoredAppSettings {
    auto_start_backend: bool,
    auto_download_updates: bool,
    user_display_name: String,
    theme_mode: String,
    chat: StoredChatSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
struct StoredChatSettings {
    reply_language: String,
    max_tokens: u32,
    web_assist_enabled: bool,
    knowledge_enabled: bool,
    generation: StoredGenerationSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
struct StoredGenerationSettings {
    temperature: Option<f32>,
    top_p: Option<f32>,
    thinking_enabled: Option<bool>,
    #[serde(deserialize_with = "deserialize_speculative_decoding_lossy")]
    speculative_decoding: SpeculativeDecodingMode,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            auto_start_backend: true,
            auto_download_updates: true,
            user_display_name: String::new(),
            theme_mode: DEFAULT_THEME_MODE.to_string(),
            chat: ChatSettings::default(),
        }
    }
}

impl Default for ChatSettings {
    fn default() -> Self {
        Self {
            reply_language: "english".to_string(),
            max_tokens: DEFAULT_MAX_TOKENS,
            web_assist_enabled: false,
            knowledge_enabled: false,
            generation: GenerationSettings::default(),
        }
    }
}

impl Default for AppSettingsInput {
    fn default() -> Self {
        Self {
            auto_start_backend: true,
            auto_download_updates: true,
            user_display_name: String::new(),
            theme_mode: DEFAULT_THEME_MODE.to_string(),
            chat: ChatSettingsInput::default(),
        }
    }
}

impl Default for ChatSettingsInput {
    fn default() -> Self {
        Self {
            reply_language: "english".to_string(),
            max_tokens: DEFAULT_MAX_TOKENS,
            web_assist_enabled: false,
            knowledge_enabled: false,
            generation: GenerationSettingsInput::default(),
        }
    }
}

impl Default for StoredAppSettings {
    fn default() -> Self {
        Self {
            auto_start_backend: true,
            auto_download_updates: true,
            user_display_name: String::new(),
            theme_mode: DEFAULT_THEME_MODE.to_string(),
            chat: StoredChatSettings::default(),
        }
    }
}

impl Default for StoredChatSettings {
    fn default() -> Self {
        Self {
            reply_language: "english".to_string(),
            max_tokens: DEFAULT_MAX_TOKENS,
            web_assist_enabled: false,
            knowledge_enabled: false,
            generation: StoredGenerationSettings::default(),
        }
    }
}

impl From<StoredAppSettings> for AppSettings {
    fn from(value: StoredAppSettings) -> Self {
        Self {
            auto_start_backend: true,
            auto_download_updates: value.auto_download_updates,
            user_display_name: value.user_display_name,
            theme_mode: value.theme_mode,
            chat: ChatSettings {
                reply_language: value.chat.reply_language,
                max_tokens: value.chat.max_tokens,
                web_assist_enabled: value.chat.web_assist_enabled,
                knowledge_enabled: value.chat.knowledge_enabled,
                generation: GenerationSettings {
                    temperature: value.chat.generation.temperature,
                    top_p: value.chat.generation.top_p,
                    thinking_enabled: value.chat.generation.thinking_enabled,
                    speculative_decoding: value.chat.generation.speculative_decoding,
                },
            },
        }
    }
}

impl From<&AppSettingsInput> for StoredAppSettings {
    fn from(value: &AppSettingsInput) -> Self {
        Self {
            auto_start_backend: true,
            auto_download_updates: value.auto_download_updates,
            user_display_name: value.user_display_name.clone(),
            theme_mode: value.theme_mode.clone(),
            chat: StoredChatSettings {
                reply_language: value.chat.reply_language.clone(),
                max_tokens: value.chat.max_tokens,
                web_assist_enabled: value.chat.web_assist_enabled,
                knowledge_enabled: value.chat.knowledge_enabled,
                generation: StoredGenerationSettings {
                    temperature: value.chat.generation.temperature,
                    top_p: value.chat.generation.top_p,
                    thinking_enabled: value.chat.generation.thinking_enabled,
                    speculative_decoding: value.chat.generation.speculative_decoding,
                },
            },
        }
    }
}

impl ChatSettings {
    pub fn generation_request_config(&self) -> GenerationRequestConfig {
        GenerationRequestConfig {
            max_output_tokens: self.max_tokens,
            temperature: self.generation.temperature,
            top_p: self.generation.top_p,
            thinking_enabled: self.generation.thinking_enabled,
        }
    }
}

pub fn load_settings(conn: &Connection) -> Result<AppSettings, String> {
    let defaults = default_stored_app_settings_for_current_system();
    let (stored, should_rewrite) = match storage::load_string_setting(conn, APP_SETTINGS_KEY)? {
        Some(raw) => match serde_json::from_str::<StoredAppSettings>(&raw) {
            Ok(parsed) => {
                let normalized = normalize_stored_settings(parsed.clone(), &defaults);
                let needs_rewrite =
                    normalized != parsed || missing_auto_download_updates_field(&raw);
                (normalized, needs_rewrite)
            }
            Err(error) => {
                tracing::warn!(
                    key = APP_SETTINGS_KEY,
                    error = %error,
                    "Failed to parse persisted settings; restoring defaults"
                );
                (defaults.clone(), true)
            }
        },
        None => (defaults, false),
    };

    if should_rewrite {
        storage::save_json_setting(conn, APP_SETTINGS_KEY, &stored)?;
    }

    Ok(AppSettings::from(stored))
}

pub fn save_settings(conn: &Connection, input: &AppSettingsInput) -> Result<AppSettings, String> {
    validate_settings_input(input)?;
    let stored = StoredAppSettings::from(input);
    storage::save_json_setting(conn, APP_SETTINGS_KEY, &stored)?;
    load_settings(conn)
}

fn is_supported_reply_language(reply_language: &str) -> bool {
    SUPPORTED_REPLY_LANGUAGES.contains(&reply_language)
}

fn validate_settings_input(input: &AppSettingsInput) -> Result<(), String> {
    let reply_language = input.chat.reply_language.as_str();
    if !is_supported_reply_language(reply_language) {
        return Err(format!("Unsupported reply language: {}", reply_language));
    }

    if !(MIN_MAX_TOKENS..=MAX_MAX_TOKENS).contains(&input.chat.max_tokens) {
        return Err(format!(
            "max_tokens must be between {} and {}",
            MIN_MAX_TOKENS, MAX_MAX_TOKENS
        ));
    }

    if let Some(temperature) = input.chat.generation.temperature {
        if !(0.0..=2.0).contains(&temperature) {
            return Err("temperature must be between 0.0 and 2.0".to_string());
        }
    }

    if let Some(top_p) = input.chat.generation.top_p {
        if !(0.0..=1.0).contains(&top_p) {
            return Err("top_p must be between 0.0 and 1.0".to_string());
        }
    }

    if input.user_display_name.trim().chars().count() > 60 {
        return Err("user_display_name must be 60 characters or fewer".to_string());
    }

    let theme_mode = input.theme_mode.as_str();
    if !matches!(theme_mode, "light" | "dark") {
        return Err(format!("Unsupported theme mode: {}", theme_mode));
    }

    Ok(())
}

fn normalize_stored_settings(
    mut stored: StoredAppSettings,
    defaults: &StoredAppSettings,
) -> StoredAppSettings {
    stored.auto_start_backend = true;

    if !matches!(stored.theme_mode.as_str(), "light" | "dark") {
        stored.theme_mode = defaults.theme_mode.clone();
    }

    if !is_supported_reply_language(stored.chat.reply_language.as_str()) {
        stored.chat.reply_language = defaults.chat.reply_language.clone();
    }

    stored.chat.max_tokens = stored.chat.max_tokens.clamp(MIN_MAX_TOKENS, MAX_MAX_TOKENS);

    stored.chat.generation.temperature = stored
        .chat
        .generation
        .temperature
        .map(|temperature| temperature.clamp(0.0, 2.0));

    stored.chat.generation.top_p = stored
        .chat
        .generation
        .top_p
        .map(|top_p| top_p.clamp(0.0, 1.0));

    if stored.user_display_name.chars().count() > 60 {
        stored.user_display_name = stored.user_display_name.chars().take(60).collect();
    }

    stored
}

fn default_stored_app_settings_for_current_system() -> StoredAppSettings {
    let mut settings = StoredAppSettings::default();
    settings.chat.max_tokens = default_max_tokens_for_ram_gb(total_ram_gb());
    settings
}

fn missing_auto_download_updates_field(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| {
            value
                .as_object()
                .map(|object| !object.contains_key("auto_download_updates"))
        })
        .unwrap_or(false)
}

fn default_max_tokens_for_ram_gb(total_ram_gb: f64) -> u32 {
    if total_ram_gb > 8.0 {
        HIGH_RAM_DEFAULT_MAX_TOKENS
    } else {
        DEFAULT_MAX_TOKENS
    }
}

fn total_ram_gb() -> f64 {
    let mut system = System::new();
    system.refresh_memory();
    system.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        conn
    }

    #[test]
    fn settings_round_trip_persists_chat_preferences() {
        let conn = test_conn();

        let saved = save_settings(
            &conn,
            &AppSettingsInput {
                auto_start_backend: false,
                auto_download_updates: false,
                user_display_name: "Asha".to_string(),
                theme_mode: "dark".to_string(),
                chat: ChatSettingsInput {
                    reply_language: "spanish".to_string(),
                    max_tokens: 6144,
                    web_assist_enabled: true,
                    knowledge_enabled: true,
                    generation: GenerationSettingsInput {
                        temperature: Some(0.7),
                        top_p: Some(0.9),
                        thinking_enabled: None,
                        speculative_decoding: SpeculativeDecodingMode::Enabled,
                    },
                },
            },
        )
        .unwrap();

        assert!(saved.auto_start_backend);
        assert!(!saved.auto_download_updates);
        assert_eq!(saved.user_display_name, "Asha");
        assert_eq!(saved.theme_mode, "dark");
        assert_eq!(saved.chat.reply_language, "spanish");
        assert_eq!(saved.chat.max_tokens, 6144);
        assert!(saved.chat.web_assist_enabled);
        assert!(saved.chat.knowledge_enabled);
        assert_eq!(saved.chat.generation.temperature, Some(0.7));
        assert_eq!(saved.chat.generation.top_p, Some(0.9));
        assert_eq!(
            saved.chat.generation.speculative_decoding,
            SpeculativeDecodingMode::Enabled
        );

        let loaded = load_settings(&conn).unwrap();
        assert_eq!(loaded, saved);
    }

    #[test]
    fn save_settings_rejects_unknown_reply_language() {
        let conn = test_conn();

        let error = save_settings(
            &conn,
            &AppSettingsInput {
                auto_start_backend: true,
                auto_download_updates: true,
                user_display_name: String::new(),
                theme_mode: DEFAULT_THEME_MODE.to_string(),
                chat: ChatSettingsInput {
                    reply_language: "korean".to_string(),
                    ..ChatSettingsInput::default()
                },
            },
        )
        .unwrap_err();

        assert!(error.contains("Unsupported reply language"));
    }

    #[test]
    fn save_settings_rejects_out_of_range_max_tokens() {
        let conn = test_conn();

        let error = save_settings(
            &conn,
            &AppSettingsInput {
                auto_start_backend: true,
                auto_download_updates: true,
                user_display_name: String::new(),
                theme_mode: DEFAULT_THEME_MODE.to_string(),
                chat: ChatSettingsInput {
                    max_tokens: MAX_MAX_TOKENS + 1,
                    ..ChatSettingsInput::default()
                },
            },
        )
        .unwrap_err();

        assert!(error.contains("max_tokens must be between"));
    }

    #[test]
    fn high_ram_default_uses_16k() {
        assert_eq!(
            default_max_tokens_for_ram_gb(8.01),
            HIGH_RAM_DEFAULT_MAX_TOKENS
        );
        assert_eq!(
            default_max_tokens_for_ram_gb(16.0),
            HIGH_RAM_DEFAULT_MAX_TOKENS
        );
    }

    #[test]
    fn standard_ram_default_uses_4k() {
        assert_eq!(default_max_tokens_for_ram_gb(8.0), DEFAULT_MAX_TOKENS);
        assert_eq!(default_max_tokens_for_ram_gb(4.0), DEFAULT_MAX_TOKENS);
    }

    #[test]
    fn generation_request_config_uses_chat_defaults() {
        let chat = ChatSettings {
            reply_language: "english".to_string(),
            max_tokens: 8192,
            web_assist_enabled: false,
            knowledge_enabled: true,
            generation: GenerationSettings {
                temperature: Some(0.6),
                top_p: Some(0.8),
                thinking_enabled: None,
                speculative_decoding: SpeculativeDecodingMode::Disabled,
            },
        };

        let config = chat.generation_request_config();

        assert_eq!(config.max_output_tokens, 8192);
        assert_eq!(config.temperature, Some(0.6));
        assert_eq!(config.top_p, Some(0.8));
        assert_eq!(config.thinking_enabled, None);
    }

    #[test]
    fn save_settings_rejects_out_of_range_generation_controls() {
        let conn = test_conn();

        let temp_error = save_settings(
            &conn,
            &AppSettingsInput {
                auto_start_backend: true,
                auto_download_updates: true,
                user_display_name: String::new(),
                theme_mode: DEFAULT_THEME_MODE.to_string(),
                chat: ChatSettingsInput {
                    generation: GenerationSettingsInput {
                        temperature: Some(2.1),
                        ..GenerationSettingsInput::default()
                    },
                    ..ChatSettingsInput::default()
                },
            },
        )
        .unwrap_err();

        let top_p_error = save_settings(
            &conn,
            &AppSettingsInput {
                auto_start_backend: true,
                auto_download_updates: true,
                user_display_name: String::new(),
                theme_mode: DEFAULT_THEME_MODE.to_string(),
                chat: ChatSettingsInput {
                    generation: GenerationSettingsInput {
                        top_p: Some(1.1),
                        ..GenerationSettingsInput::default()
                    },
                    ..ChatSettingsInput::default()
                },
            },
        )
        .unwrap_err();

        assert!(temp_error.contains("temperature"));
        assert!(top_p_error.contains("top_p"));
    }

    #[test]
    fn save_settings_rejects_too_long_display_name() {
        let conn = test_conn();

        let error = save_settings(
            &conn,
            &AppSettingsInput {
                auto_start_backend: true,
                auto_download_updates: true,
                user_display_name: "a".repeat(61),
                theme_mode: DEFAULT_THEME_MODE.to_string(),
                chat: ChatSettingsInput::default(),
            },
        )
        .unwrap_err();

        assert!(error.contains("user_display_name"));
    }

    #[test]
    fn save_settings_counts_display_name_length_by_characters() {
        let conn = test_conn();
        let valid_name = "आ".repeat(60);
        let too_long_name = "आ".repeat(61);

        let saved = save_settings(
            &conn,
            &AppSettingsInput {
                auto_start_backend: true,
                auto_download_updates: true,
                user_display_name: valid_name.clone(),
                theme_mode: DEFAULT_THEME_MODE.to_string(),
                chat: ChatSettingsInput::default(),
            },
        )
        .expect("save valid multibyte name");
        assert_eq!(saved.user_display_name, valid_name);

        let error = save_settings(
            &conn,
            &AppSettingsInput {
                auto_start_backend: true,
                auto_download_updates: true,
                user_display_name: too_long_name,
                theme_mode: DEFAULT_THEME_MODE.to_string(),
                chat: ChatSettingsInput::default(),
            },
        )
        .unwrap_err();
        assert!(error.contains("user_display_name"));
    }

    #[test]
    fn save_settings_rejects_unknown_theme_mode() {
        let conn = test_conn();

        let error = save_settings(
            &conn,
            &AppSettingsInput {
                auto_start_backend: true,
                auto_download_updates: true,
                user_display_name: String::new(),
                theme_mode: "system".to_string(),
                chat: ChatSettingsInput::default(),
            },
        )
        .unwrap_err();

        assert!(error.contains("Unsupported theme mode"));
    }

    #[test]
    fn load_settings_recovers_from_malformed_json_and_rewrites_payload() {
        let conn = test_conn();

        storage::save_string_setting(&conn, APP_SETTINGS_KEY, "{invalid-json")
            .expect("save malformed payload");

        let loaded = load_settings(&conn).expect("load settings");
        assert!(loaded.auto_start_backend);
        assert!(loaded.auto_download_updates);

        let rewritten = storage::load_string_setting(&conn, APP_SETTINGS_KEY)
            .expect("load rewritten payload")
            .expect("payload exists");
        let persisted: StoredAppSettings =
            serde_json::from_str(&rewritten).expect("valid rewritten settings JSON");

        assert_eq!(AppSettings::from(persisted), loaded);
    }

    #[test]
    fn load_settings_normalizes_invalid_values_and_rewrites_payload() {
        let conn = test_conn();

        let oversized_name = "x".repeat(80);
        let raw = serde_json::json!({
            "auto_start_backend": false,
            "user_display_name": oversized_name,
            "theme_mode": "system",
            "chat": {
                "reply_language": "mandarin",
                "max_tokens": 0,
                "web_assist_enabled": true,
                "knowledge_enabled": true,
                "generation": {
                    "temperature": -0.5,
                    "top_p": 3.2,
                    "thinking_enabled": true,
                    "speculative_decoding": "unexpected"
                }
            }
        })
        .to_string();

        storage::save_string_setting(&conn, APP_SETTINGS_KEY, &raw).expect("save malformed values");

        let loaded = load_settings(&conn).expect("load normalized settings");
        assert!(loaded.auto_start_backend);
        assert!(loaded.auto_download_updates);
        assert_eq!(loaded.theme_mode, DEFAULT_THEME_MODE);
        assert_eq!(loaded.chat.reply_language, "mandarin");
        assert_eq!(loaded.chat.max_tokens, MIN_MAX_TOKENS);
        assert_eq!(loaded.chat.generation.temperature, Some(0.0));
        assert_eq!(loaded.chat.generation.top_p, Some(1.0));
        assert_eq!(
            loaded.chat.generation.speculative_decoding,
            SpeculativeDecodingMode::Auto
        );
        assert_eq!(loaded.user_display_name.chars().count(), 60);

        let rewritten = storage::load_string_setting(&conn, APP_SETTINGS_KEY)
            .expect("load rewritten payload")
            .expect("payload exists");
        let persisted: StoredAppSettings =
            serde_json::from_str(&rewritten).expect("valid rewritten settings JSON");
        assert_eq!(persisted.auto_start_backend, true);
        assert!(persisted.auto_download_updates);
        assert_eq!(persisted.chat.reply_language, "mandarin");
        assert_eq!(persisted.chat.max_tokens, MIN_MAX_TOKENS);
        assert_eq!(persisted.chat.generation.temperature, Some(0.0));
        assert_eq!(persisted.chat.generation.top_p, Some(1.0));
        assert_eq!(
            persisted.chat.generation.speculative_decoding,
            SpeculativeDecodingMode::Auto
        );
    }

    #[test]
    fn default_settings_enable_auto_download_updates() {
        assert!(AppSettings::default().auto_download_updates);
        assert!(AppSettingsInput::default().auto_download_updates);
        assert!(StoredAppSettings::default().auto_download_updates);
    }

    #[test]
    fn default_generation_settings_use_auto_speculative_decoding() {
        assert_eq!(
            GenerationSettings::default().speculative_decoding,
            SpeculativeDecodingMode::Auto
        );
        assert_eq!(
            GenerationSettingsInput::default().speculative_decoding,
            SpeculativeDecodingMode::Auto
        );
        assert_eq!(
            StoredGenerationSettings::default().speculative_decoding,
            SpeculativeDecodingMode::Auto
        );
    }

    #[test]
    fn load_settings_rewrites_legacy_payload_without_auto_download_updates() {
        let conn = test_conn();

        let raw = serde_json::json!({
            "auto_start_backend": true,
            "user_display_name": "Asha",
            "theme_mode": "light",
            "chat": {
                "reply_language": "english",
                "max_tokens": 4096,
                "web_assist_enabled": false,
                "knowledge_enabled": false,
                "generation": {
                    "thinking_enabled": true
                }
            }
        })
        .to_string();

        storage::save_string_setting(&conn, APP_SETTINGS_KEY, &raw).expect("save legacy payload");

        let loaded = load_settings(&conn).expect("load legacy settings");
        assert!(loaded.auto_download_updates);

        let rewritten = storage::load_string_setting(&conn, APP_SETTINGS_KEY)
            .expect("load rewritten payload")
            .expect("payload exists");
        let persisted: serde_json::Value =
            serde_json::from_str(&rewritten).expect("valid rewritten settings JSON");
        assert_eq!(
            persisted.get("auto_download_updates"),
            Some(&serde_json::Value::Bool(true))
        );
    }
}
