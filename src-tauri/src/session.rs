use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub role: String, // "user" | "assistant" | "system"
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_parts: Option<Value>,
    pub model_used: Option<String>,
    pub tokens_used: Option<i64>,
    pub latency_ms: Option<i64>,
    pub created_at: String,
}
