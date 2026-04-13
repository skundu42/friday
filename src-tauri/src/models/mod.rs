pub mod python_worker;

use serde::{Deserialize, Serialize};

/// A content part supported by LiteRT-LM chat messages.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ChatContentPart {
    Text { text: String },
    Image { blob: String },
    Audio { path: String },
}

/// Chat message content used across the inference layer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ChatContent {
    Text(String),
    Parts(Vec<ChatContentPart>),
}

impl ChatContent {
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }
}

/// Chat message format used across the inference layer.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant" | "tool"
    pub content: ChatContent,
}

impl ChatMessage {
    pub fn text(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: ChatContent::text(content),
        }
    }
}
