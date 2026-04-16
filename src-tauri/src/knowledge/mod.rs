use anyhow::Context;
use arrow_array::types::Float32Type;
use arrow_array::{
    ArrayRef, FixedSizeListArray, Float32Array, Int32Array, RecordBatch, StringArray,
};
use arrow_schema::{DataType, Field, Schema};
use embed_anything::config::TextEmbedConfig;
use embed_anything::embeddings::embed::{EmbedData, Embedder, EmbedderBuilder};
use embed_anything::file_processor::audio::audio_processor::AudioDecoderModel;
use embed_anything::{emb_audio, embed_file, embed_query, embed_webpage};
use futures::TryStreamExt;
use lance_index::scalar::FullTextSearchQuery;
use lancedb::connection::Connection as LanceConnection;
use lancedb::index::scalar::FtsIndexBuilder;
use lancedb::index::Index;
use lancedb::query::{ExecutableQuery, QueryBase, QueryExecutionOptions};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::Mutex as AsyncMutex;

const TEXT_MODEL_ID: &str = "jinaai/jina-embeddings-v2-small-en";
const IMAGE_MODEL_ID: &str = "openai/clip-vit-base-patch32";
const AUDIO_MODEL_ID: &str = "openai/whisper-small";

const TEXT_TABLE: &str = "text_chunks";
const IMAGE_TABLE: &str = "image_assets";

const DEFAULT_QUERY_TOP_K: usize = 6;
const MAX_PROMPT_TEXT_SNIPPETS: usize = 4;
const MAX_PROMPT_IMAGES: usize = 2;
const MAX_PROMPT_TEXT_TOTAL_CHARS: usize = 3000;
const MAX_PROMPT_TEXT_SNIPPET_CHARS: usize = 600;
const MIN_VECTOR_INDEX_ROWS: usize = 256;
const KNOWLEDGE_WRITE_BATCH_SIZE: usize = 64;
const KNOWLEDGE_RUNTIME_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const KNOWLEDGE_RUNTIME_IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(30);
const KNOWLEDGE_DB_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeStatusState {
    Unavailable,
    NeedsModels,
    DownloadingModels,
    Ready,
    Indexing,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeStatus {
    pub state: KnowledgeStatusState,
    pub message: String,
}

impl KnowledgeStatus {
    fn unavailable() -> Self {
        Self {
            state: KnowledgeStatusState::Unavailable,
            message: "Knowledge storage is unavailable.".to_string(),
        }
    }

    fn needs_models() -> Self {
        Self {
            state: KnowledgeStatusState::NeedsModels,
            message: "Knowledge models will download on first use.".to_string(),
        }
    }

    fn ready() -> Self {
        Self {
            state: KnowledgeStatusState::Ready,
            message: "Knowledge is ready.".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeSourceKind {
    File,
    Url,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeModality {
    Text,
    Image,
    Audio,
    Webpage,
}

impl KnowledgeModality {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
            Self::Audio => "audio",
            Self::Webpage => "webpage",
        }
    }

    fn from_db(value: &str) -> Self {
        match value {
            "image" => Self::Image,
            "audio" => Self::Audio,
            "webpage" => Self::Webpage,
            _ => Self::Text,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSource {
    pub id: String,
    pub source_kind: KnowledgeSourceKind,
    pub modality: KnowledgeModality,
    pub locator: String,
    pub display_name: String,
    pub mime_type: Option<String>,
    pub file_size_bytes: Option<u64>,
    pub asset_path: Option<String>,
    pub content_hash: String,
    pub status: String,
    pub error: Option<String>,
    pub chunk_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCitation {
    pub source_id: String,
    pub modality: KnowledgeModality,
    pub display_name: String,
    pub locator: String,
    pub score: f32,
    pub chunk_index: Option<i32>,
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeIngestResult {
    pub source_id: Option<String>,
    pub display_name: String,
    pub modality: KnowledgeModality,
    pub status: String,
    pub chunk_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDeleteResult {
    pub deleted: bool,
    pub source_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeStats {
    pub total_sources: usize,
    pub ready_sources: usize,
    pub total_text_chunks: usize,
    pub total_image_assets: usize,
    pub storage_dir: String,
}

struct KnowledgeRuntime {
    db: Option<LanceConnection>,
    text_embedder: Option<Arc<Embedder>>,
    image_embedder: Option<Arc<Embedder>>,
    text_config: TextEmbedConfig,
}

impl Default for KnowledgeRuntime {
    fn default() -> Self {
        Self {
            db: None,
            text_embedder: None,
            image_embedder: None,
            text_config: TextEmbedConfig::default().with_chunk_size(1000, Some(0.1)),
        }
    }
}

impl KnowledgeRuntime {
    fn has_loaded_components(&self) -> bool {
        self.db.is_some() || self.text_embedder.is_some() || self.image_embedder.is_some()
    }

    fn unload(&mut self) {
        self.db = None;
        self.text_embedder = None;
        self.image_embedder = None;
    }
}

struct KnowledgeActivity {
    last_activity: Mutex<Instant>,
    active_uses: AtomicUsize,
    monitor_started: AtomicBool,
}

impl KnowledgeActivity {
    fn new() -> Self {
        Self {
            last_activity: Mutex::new(Instant::now()),
            active_uses: AtomicUsize::new(0),
            monitor_started: AtomicBool::new(false),
        }
    }

    fn touch(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }

    fn idle_deadline_reached(&self, now: Instant) -> bool {
        let last_activity = *self.last_activity.lock().unwrap();
        knowledge_runtime_idle(last_activity, self.active_uses.load(Ordering::SeqCst), now)
    }
}

pub struct KnowledgeUseGuard {
    activity: Arc<KnowledgeActivity>,
}

impl Drop for KnowledgeUseGuard {
    fn drop(&mut self) {
        self.activity.touch();
        self.activity.active_uses.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct KnowledgeManager {
    root_dir: Mutex<Option<PathBuf>>,
    runtime: Arc<AsyncMutex<KnowledgeRuntime>>,
    status: Mutex<KnowledgeStatus>,
    activity: Arc<KnowledgeActivity>,
}

impl Default for KnowledgeManager {
    fn default() -> Self {
        Self::new()
    }
}

impl KnowledgeManager {
    pub fn new() -> Self {
        Self {
            root_dir: Mutex::new(None),
            runtime: Arc::new(AsyncMutex::new(KnowledgeRuntime::default())),
            status: Mutex::new(KnowledgeStatus::unavailable()),
            activity: Arc::new(KnowledgeActivity::new()),
        }
    }

    pub fn set_root_dir(&self, root_dir: PathBuf) -> Result<(), String> {
        std::fs::create_dir_all(root_dir.join("lancedb"))
            .map_err(|e| format!("Failed to create Knowledge storage: {}", e))?;
        std::fs::create_dir_all(root_dir.join("models"))
            .map_err(|e| format!("Failed to create Knowledge model cache: {}", e))?;
        std::fs::create_dir_all(root_dir.join("hf-cache"))
            .map_err(|e| format!("Failed to create Knowledge Hugging Face cache: {}", e))?;
        std::fs::create_dir_all(root_dir.join("staging"))
            .map_err(|e| format!("Failed to create Knowledge staging area: {}", e))?;

        let marker_exists = root_dir.join("models").join(".provisioned").exists();
        *self.root_dir.lock().unwrap() = Some(root_dir);
        *self.status.lock().unwrap() = if marker_exists {
            KnowledgeStatus::ready()
        } else {
            KnowledgeStatus::needs_models()
        };
        self.ensure_idle_monitor();
        Ok(())
    }

    pub fn status(&self) -> KnowledgeStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn storage_dir(&self) -> Result<PathBuf, String> {
        self.root_dir
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "Knowledge storage is unavailable.".to_string())
    }

    fn set_status(&self, app: Option<&tauri::AppHandle>, status: KnowledgeStatus) {
        *self.status.lock().unwrap() = status.clone();
        if let Some(app) = app {
            let _ = app.emit("knowledge-status", &status);
        }
    }

    pub fn begin_use(&self) -> KnowledgeUseGuard {
        self.activity.touch();
        self.activity.active_uses.fetch_add(1, Ordering::SeqCst);
        KnowledgeUseGuard {
            activity: Arc::clone(&self.activity),
        }
    }

    async fn ensure_runtime_components(
        &self,
        app: Option<&tauri::AppHandle>,
        need_text: bool,
        need_image: bool,
    ) -> Result<(), String> {
        let root_dir = self.storage_dir()?;
        Self::configure_environment(&root_dir);

        let (load_db, load_text, load_image) = {
            let runtime = self.runtime.lock().await;
            (
                runtime.db.is_none(),
                need_text && runtime.text_embedder.is_none(),
                need_image && runtime.image_embedder.is_none(),
            )
        };
        if !(load_db || load_text || load_image) {
            return Ok(());
        }

        if load_text || load_image {
            self.set_status(
                app,
                KnowledgeStatus {
                    state: KnowledgeStatusState::DownloadingModels,
                    message: knowledge_runtime_message(load_text, load_image),
                },
            );
        }
        tracing::info!(
            load_db,
            load_text,
            load_image,
            "Loading Knowledge runtime components"
        );

        let result = async {
            if load_db {
                let connection =
                    lancedb::connect(root_dir.join("lancedb").to_string_lossy().as_ref())
                        .execute()
                        .await
                        .context("Failed to open LanceDB")?;
                let mut runtime = self.runtime.lock().await;
                if runtime.db.is_none() {
                    runtime.db = Some(connection);
                }
            }

            if load_text {
                let runtime = Arc::clone(&self.runtime);
                tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                    let embedder = Arc::new(
                        EmbedderBuilder::new()
                            .model_id(Some(TEXT_MODEL_ID))
                            .from_pretrained_hf()
                            .with_context(|| {
                                format!("Failed to load text embedder {}", TEXT_MODEL_ID)
                            })?,
                    );
                    let mut runtime = runtime.blocking_lock();
                    if runtime.text_embedder.is_none() {
                        runtime.text_embedder = Some(embedder);
                    }
                    Ok(())
                })
                .await
                .context("Knowledge text runtime task failed")??;
            }

            if load_image {
                let runtime = Arc::clone(&self.runtime);
                tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                    let embedder = Arc::new(
                        EmbedderBuilder::new()
                            .model_id(Some(IMAGE_MODEL_ID))
                            .from_pretrained_hf()
                            .with_context(|| {
                                format!("Failed to load image embedder {}", IMAGE_MODEL_ID)
                            })?,
                    );
                    let mut runtime = runtime.blocking_lock();
                    if runtime.image_embedder.is_none() {
                        runtime.image_embedder = Some(embedder);
                    }
                    Ok(())
                })
                .await
                .context("Knowledge image runtime task failed")??;
            }

            Ok::<(), anyhow::Error>(())
        }
        .await;

        match result {
            Ok(()) => {
                if load_text || load_image {
                    Self::write_provisioned_marker(&root_dir);
                    self.set_status(app, KnowledgeStatus::ready());
                }
                tracing::info!(
                    load_db,
                    load_text,
                    load_image,
                    "Loaded Knowledge runtime components"
                );
                Ok(())
            }
            Err(error) => {
                if load_text || load_image {
                    self.set_status(
                        app,
                        KnowledgeStatus {
                            state: KnowledgeStatusState::Error,
                            message: error.to_string(),
                        },
                    );
                }
                Err(error.to_string())
            }
        }
    }

    fn ensure_idle_monitor(&self) {
        if self.activity.monitor_started.swap(true, Ordering::SeqCst) {
            return;
        }

        let runtime = Arc::clone(&self.runtime);
        let activity = Arc::clone(&self.activity);
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(KNOWLEDGE_RUNTIME_IDLE_CHECK_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                interval.tick().await;
                if unload_runtime_if_idle(&runtime, &activity, Instant::now()).await {
                    tracing::info!(
                        timeout_seconds = KNOWLEDGE_RUNTIME_IDLE_TIMEOUT.as_secs(),
                        "Unloaded Knowledge runtime after inactivity"
                    );
                }
            }
        });
    }

    fn configure_environment(root_dir: &Path) {
        let model_cache = root_dir.join("models");
        let hf_cache = root_dir.join("hf-cache");
        std::env::set_var("HF_HOME", &hf_cache);
        std::env::set_var("HF_HUB_CACHE", &model_cache);
        std::env::set_var("HUGGINGFACE_HUB_CACHE", &model_cache);
        std::env::set_var("HF_ASSETS_CACHE", hf_cache.join("assets"));
        std::env::set_var("XDG_CACHE_HOME", &hf_cache);
    }

    fn write_provisioned_marker(root_dir: &Path) {
        if let Err(error) = std::fs::write(
            root_dir.join("models").join(".provisioned"),
            format!(
                "text={}\nimage={}\naudio={}\n",
                TEXT_MODEL_ID, IMAGE_MODEL_ID, AUDIO_MODEL_ID
            ),
        ) {
            tracing::warn!("Failed to write Knowledge model marker: {}", error);
        }
    }
}

async fn unload_runtime_if_idle(
    runtime: &AsyncMutex<KnowledgeRuntime>,
    activity: &KnowledgeActivity,
    now: Instant,
) -> bool {
    if !activity.idle_deadline_reached(now) {
        return false;
    }

    let mut runtime = runtime.lock().await;
    if activity.active_uses.load(Ordering::SeqCst) > 0
        || !activity.idle_deadline_reached(now)
        || !runtime.has_loaded_components()
    {
        return false;
    }

    let unloaded_db = runtime.db.is_some();
    let unloaded_text = runtime.text_embedder.is_some();
    let unloaded_image = runtime.image_embedder.is_some();
    runtime.unload();
    tracing::info!(
        unloaded_db,
        unloaded_text,
        unloaded_image,
        "Unloaded Knowledge runtime components"
    );
    true
}

fn knowledge_runtime_message(load_text: bool, load_image: bool) -> String {
    match (load_text, load_image) {
        (true, true) => "Preparing Knowledge text and image runtime.".to_string(),
        (true, false) => "Preparing Knowledge text runtime.".to_string(),
        (false, true) => "Preparing Knowledge image runtime.".to_string(),
        (false, false) => "Preparing Knowledge runtime.".to_string(),
    }
}

fn should_skip_knowledge_query(query: &str) -> bool {
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }

    if normalized.len() <= 3
        && normalized
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return true;
    }

    matches!(
        normalized.as_str(),
        "hi" | "hello" | "hey" | "yo" | "thanks" | "thank you" | "ok" | "okay" | "cool"
    )
}

fn knowledge_runtime_idle(last_activity: Instant, active_uses: usize, now: Instant) -> bool {
    active_uses == 0
        && now.saturating_duration_since(last_activity) >= KNOWLEDGE_RUNTIME_IDLE_TIMEOUT
}

fn open_db(db_path: &Path) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(db_path).map_err(|e| {
        format!(
            "Failed to open Knowledge database {}: {}",
            db_path.display(),
            e
        )
    })?;
    conn.busy_timeout(KNOWLEDGE_DB_BUSY_TIMEOUT)
        .map_err(|e| format!("Failed to configure Knowledge database busy timeout: {}", e))?;
    Ok(conn)
}

#[derive(Debug, Clone)]
struct SourceRecord {
    id: String,
    source_kind: KnowledgeSourceKind,
    modality: KnowledgeModality,
    locator: String,
    display_name: String,
    mime_type: Option<String>,
    file_size_bytes: Option<u64>,
    asset_path: Option<String>,
    content_hash: String,
    chunk_count: usize,
}

#[derive(Debug, Clone)]
struct ExistingSourceMatch {
    id: String,
    chunk_count: usize,
}

#[derive(Debug, Clone)]
struct TextChunkInsert {
    source_id: String,
    chunk_id: String,
    chunk_index: i32,
    text: String,
    modality: KnowledgeModality,
    locator: String,
    display_name: String,
    mime_type: Option<String>,
    asset_path: Option<String>,
    embedding: Vec<f32>,
}

#[derive(Debug, Clone)]
struct ImageAssetInsert {
    source_id: String,
    asset_id: String,
    locator: String,
    display_name: String,
    mime_type: Option<String>,
    asset_path: Option<String>,
    embedding: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct RetrievedTextSnippet {
    pub citation: KnowledgeCitation,
    pub snippet: String,
}

#[derive(Debug, Clone)]
pub struct RetrievedImage {
    pub citation: KnowledgeCitation,
    pub asset_path: PathBuf,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RetrievedAudio {
    pub asset_path: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct KnowledgeSearchResults {
    pub citations: Vec<KnowledgeCitation>,
    pub text_snippets: Vec<RetrievedTextSnippet>,
    pub images: Vec<RetrievedImage>,
    pub audio: Option<RetrievedAudio>,
}

#[derive(Debug, Default)]
struct SearchableSources {
    ready_source_ids: HashSet<String>,
    has_text_sources: bool,
    has_image_sources: bool,
}

pub async fn ingest_file(
    manager: &KnowledgeManager,
    db_path: &Path,
    app: Option<&tauri::AppHandle>,
    file_path: &str,
) -> Result<KnowledgeIngestResult, String> {
    let _use_guard = manager.begin_use();
    let path = PathBuf::from(file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", path.display()));
    }

    manager.set_status(
        app,
        KnowledgeStatus {
            state: KnowledgeStatusState::Indexing,
            message: format!("Indexing {}", path.display()),
        },
    );

    if let Some(app) = app {
        let _ = app.emit(
            "knowledge-ingest-progress",
            serde_json::json!({
                "stage": "indexing",
                "locator": file_path,
            }),
        );
    }

    let result = ingest_file_inner(manager, db_path, &path).await;
    manager.set_status(app, KnowledgeStatus::ready());

    match result {
        Ok(result) => {
            if let Some(app) = app {
                let _ = app.emit(
                    "knowledge-ingest-progress",
                    serde_json::json!({
                        "stage": "complete",
                        "locator": file_path,
                        "chunkCount": result.chunk_count,
                    }),
                );
            }
            Ok(result)
        }
        Err(error) => {
            if let Some(app) = app {
                let _ = app.emit(
                    "knowledge-ingest-progress",
                    serde_json::json!({
                        "stage": "error",
                        "locator": file_path,
                        "error": error,
                    }),
                );
            }
            Err(error)
        }
    }
}

pub async fn ingest_url(
    manager: &KnowledgeManager,
    db_path: &Path,
    app: Option<&tauri::AppHandle>,
    url: &str,
) -> Result<KnowledgeIngestResult, String> {
    let _use_guard = manager.begin_use();
    manager.ensure_runtime_components(app, true, false).await?;
    manager.set_status(
        app,
        KnowledgeStatus {
            state: KnowledgeStatusState::Indexing,
            message: format!("Indexing {}", url),
        },
    );

    let source = {
        let runtime_guard = manager.runtime.lock().await;
        let runtime = &*runtime_guard;
        let text_embedder = runtime
            .text_embedder
            .as_ref()
            .ok_or_else(|| "Knowledge text runtime is unavailable.".to_string())?;

        let embeddings = embed_webpage(
            url.to_string(),
            text_embedder,
            Some(&runtime.text_config),
            None,
        )
        .await
        .map_err(|error| format!("Failed to ingest URL {}: {}", url, error))?
        .ok_or_else(|| format!("No Knowledge content was extracted from {}", url))?;
        let hash = hash_embed_texts(embeddings.iter())
            .ok_or_else(|| format!("No text content was extracted from {}", url))?;

        let display_name = url.to_string();
        let source = SourceRecord {
            id: uuid::Uuid::new_v4().to_string(),
            source_kind: KnowledgeSourceKind::Url,
            modality: KnowledgeModality::Webpage,
            locator: url.to_string(),
            display_name,
            mime_type: Some("text/html".to_string()),
            file_size_bytes: None,
            asset_path: None,
            content_hash: hash,
            chunk_count: embeddings.len(),
        };

        let url_source_unchanged = {
            let conn = open_db(db_path)?;
            source_unchanged(&conn, &source)?
        };
        if let Some(existing_source) = url_source_unchanged {
            manager.set_status(app, KnowledgeStatus::ready());
            return Ok(KnowledgeIngestResult {
                source_id: Some(existing_source.id),
                display_name: source.display_name,
                modality: source.modality,
                status: "skipped".to_string(),
                chunk_count: existing_source.chunk_count,
                error: None,
            });
        }

        let chunk_count = write_text_embeddings(manager, &source, embeddings).await?;
        let mut finalized_source = source;
        finalized_source.chunk_count = chunk_count;
        finalized_source
    };

    persist_replacement_source_with_cleanup(manager, db_path, &source).await?;
    manager.set_status(app, KnowledgeStatus::ready());

    Ok(KnowledgeIngestResult {
        source_id: Some(source.id),
        display_name: source.display_name,
        modality: source.modality,
        status: "indexed".to_string(),
        chunk_count: source.chunk_count,
        error: None,
    })
}

pub fn list_sources(conn: &rusqlite::Connection) -> Result<Vec<KnowledgeSource>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, source_kind, modality, locator, display_name, mime_type, file_size_bytes,
                    asset_path, content_hash, status, error, chunk_count, created_at, updated_at
             FROM knowledge_sources
             ORDER BY updated_at DESC",
        )
        .map_err(|e| format!("Failed to prepare Knowledge source list: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let source_kind: String = row.get(1)?;
            let modality: String = row.get(2)?;
            let file_size_bytes: Option<i64> = row.get(6)?;
            let chunk_count: i64 = row.get(11)?;
            Ok(KnowledgeSource {
                id: row.get(0)?,
                source_kind: if source_kind == "url" {
                    KnowledgeSourceKind::Url
                } else {
                    KnowledgeSourceKind::File
                },
                modality: KnowledgeModality::from_db(&modality),
                locator: row.get(3)?,
                display_name: row.get(4)?,
                mime_type: row.get(5)?,
                file_size_bytes: file_size_bytes.and_then(|value| u64::try_from(value).ok()),
                asset_path: row.get(7)?,
                content_hash: row.get(8)?,
                status: row.get(9)?,
                error: row.get(10)?,
                chunk_count: usize::try_from(chunk_count.max(0)).unwrap_or_default(),
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
            })
        })
        .map_err(|e| format!("Failed to query Knowledge sources: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to decode Knowledge sources: {}", e))
}

pub async fn delete_source(
    manager: &KnowledgeManager,
    db_path: &Path,
    source_id: &str,
) -> Result<KnowledgeDeleteResult, String> {
    let _use_guard = manager.begin_use();
    delete_existing_source_rows(manager, source_id).await?;
    let conn = open_db(db_path)?;
    let deleted_rows = conn
        .execute(
            "DELETE FROM knowledge_sources WHERE id = ?1",
            params![source_id],
        )
        .map_err(|e| format!("Failed to delete Knowledge source: {}", e))?;
    Ok(KnowledgeDeleteResult {
        deleted: deleted_rows > 0,
        source_id: source_id.to_string(),
    })
}

pub async fn stats(manager: &KnowledgeManager, db_path: &Path) -> Result<KnowledgeStats, String> {
    let _use_guard = manager.begin_use();
    let storage_dir = manager.storage_dir()?;
    let (total_sources, ready_sources, total_text_chunks, total_image_assets) = {
        let conn = open_db(db_path)?;
        let total_sources: usize = conn
            .query_row("SELECT COUNT(*) FROM knowledge_sources", [], |row| {
                row.get(0)
            })
            .map_err(|e| format!("Failed to count Knowledge sources: {}", e))?;
        let ready_sources: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM knowledge_sources WHERE status = 'ready'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to count ready Knowledge sources: {}", e))?;
        let mut stmt = conn
            .prepare("SELECT modality, chunk_count FROM knowledge_sources WHERE status = 'ready'")
            .map_err(|e| format!("Failed to prepare Knowledge stats query: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                let modality: String = row.get(0)?;
                let chunk_count: i64 = row.get(1)?;
                Ok((KnowledgeModality::from_db(&modality), chunk_count))
            })
            .map_err(|e| format!("Failed to query Knowledge stats: {}", e))?;
        let mut total_text_chunks = 0usize;
        let mut total_image_assets = 0usize;
        for row in rows {
            let (modality, chunk_count) =
                row.map_err(|e| format!("Failed to decode Knowledge stats row: {}", e))?;
            let count = usize::try_from(chunk_count.max(0)).unwrap_or_default();
            if modality == KnowledgeModality::Image {
                total_image_assets += count;
            } else {
                total_text_chunks += count;
            }
        }
        (
            total_sources,
            ready_sources,
            total_text_chunks,
            total_image_assets,
        )
    };

    Ok(KnowledgeStats {
        total_sources,
        ready_sources,
        total_text_chunks,
        total_image_assets,
        storage_dir: storage_dir.to_string_lossy().to_string(),
    })
}

pub async fn search(
    manager: &KnowledgeManager,
    db_path: &Path,
    query: &str,
) -> Result<KnowledgeSearchResults, String> {
    let _use_guard = manager.begin_use();
    if should_skip_knowledge_query(query) {
        return Ok(KnowledgeSearchResults::default());
    }

    let searchable_sources = load_searchable_sources(db_path)?;
    if searchable_sources.ready_source_ids.is_empty() {
        return Ok(KnowledgeSearchResults::default());
    }

    manager
        .ensure_runtime_components(None, false, false)
        .await?;
    let (text_row_count, image_row_count) = {
        let runtime_guard = manager.runtime.lock().await;
        let db = runtime_guard
            .db
            .as_ref()
            .ok_or_else(|| "Knowledge database is unavailable.".to_string())?;
        (
            if searchable_sources.has_text_sources {
                count_rows_if_exists(db, TEXT_TABLE).await?
            } else {
                0
            },
            if searchable_sources.has_image_sources {
                count_rows_if_exists(db, IMAGE_TABLE).await?
            } else {
                0
            },
        )
    };
    let search_plan = build_search_plan(text_row_count, image_row_count);
    tracing::info!(
        text_row_count,
        image_row_count,
        use_text = search_plan.use_text,
        use_image = search_plan.use_image,
        "Knowledge search modality plan"
    );
    if !search_plan.use_text && !search_plan.use_image {
        return Ok(KnowledgeSearchResults::default());
    }

    manager
        .ensure_runtime_components(None, search_plan.use_text, search_plan.use_image)
        .await?;
    let runtime_guard = manager.runtime.lock().await;
    let runtime = &*runtime_guard;
    let db = runtime
        .db
        .as_ref()
        .ok_or_else(|| "Knowledge database is unavailable.".to_string())?;
    let text_vector = if search_plan.use_text {
        let text_embedder = runtime
            .text_embedder
            .as_ref()
            .ok_or_else(|| "Knowledge text runtime is unavailable.".to_string())?;
        let text_query = embed_query(&[query], text_embedder, Some(&runtime.text_config))
            .await
            .map_err(|e| format!("Failed to embed Knowledge query: {}", e))?;
        Some(dense_embedding(&text_query[0])?)
    } else {
        None
    };
    let image_vector = if search_plan.use_image {
        let image_embedder = runtime
            .image_embedder
            .as_ref()
            .ok_or_else(|| "Knowledge image runtime is unavailable.".to_string())?;
        let image_query = embed_query(&[query], image_embedder, None)
            .await
            .map_err(|e| format!("Failed to embed Knowledge image query: {}", e))?;
        Some(dense_embedding(&image_query[0])?)
    } else {
        None
    };

    let mut citations = Vec::new();
    let mut seen_citations = HashSet::new();
    let mut text_snippets = Vec::new();
    let mut images = Vec::new();
    let mut audio = None;

    if let Some(text_vector) = text_vector.as_deref() {
        for row in filter_text_search_rows(
            search_text_rows(db, query, text_vector, DEFAULT_QUERY_TOP_K).await?,
            &searchable_sources,
        ) {
            let snippet = truncate_chars(&row.text, MAX_PROMPT_TEXT_SNIPPET_CHARS);
            let citation = KnowledgeCitation {
                source_id: row.source_id.clone(),
                modality: row.modality.clone(),
                display_name: row.display_name.clone(),
                locator: row.locator.clone(),
                score: row.score,
                chunk_index: Some(row.chunk_index),
                snippet: Some(snippet.clone()),
            };
            let dedupe_key = format!(
                "{}:{}:{}",
                citation.source_id,
                citation.modality.as_str(),
                citation.chunk_index.unwrap_or_default()
            );
            if seen_citations.insert(dedupe_key) {
                citations.push(citation.clone());
            }

            if text_snippets.len() < MAX_PROMPT_TEXT_SNIPPETS {
                text_snippets.push(RetrievedTextSnippet { citation, snippet });
            }

            if audio.is_none() && row.modality == KnowledgeModality::Audio {
                if let Some(path) = row.asset_path.as_ref() {
                    audio = Some(RetrievedAudio {
                        asset_path: PathBuf::from(path),
                    });
                }
            }
        }
    }

    if let Some(image_vector) = image_vector.as_deref() {
        for row in filter_image_search_rows(
            search_image_rows(db, image_vector, MAX_PROMPT_IMAGES).await?,
            &searchable_sources,
        ) {
            if images
                .iter()
                .any(|image: &RetrievedImage| image.citation.source_id == row.source_id)
            {
                continue;
            }

            let citation = KnowledgeCitation {
                source_id: row.source_id.clone(),
                modality: KnowledgeModality::Image,
                display_name: row.display_name.clone(),
                locator: row.locator.clone(),
                score: row.score,
                chunk_index: None,
                snippet: None,
            };
            citations.push(citation.clone());
            if let Some(asset_path) = row.asset_path {
                images.push(RetrievedImage {
                    citation,
                    asset_path: PathBuf::from(asset_path),
                    mime_type: row.mime_type,
                });
            }
        }
    }

    Ok(KnowledgeSearchResults {
        citations,
        text_snippets,
        images,
        audio,
    })
}

#[derive(Debug, Clone)]
struct TextSearchRow {
    source_id: String,
    chunk_index: i32,
    text: String,
    modality: KnowledgeModality,
    locator: String,
    display_name: String,
    asset_path: Option<String>,
    score: f32,
}

#[derive(Debug, Clone)]
struct ImageSearchRow {
    source_id: String,
    locator: String,
    display_name: String,
    mime_type: Option<String>,
    asset_path: Option<String>,
    score: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SearchPlan {
    use_text: bool,
    use_image: bool,
}

fn build_search_plan(text_row_count: usize, image_row_count: usize) -> SearchPlan {
    SearchPlan {
        use_text: text_row_count > 0,
        use_image: image_row_count > 0,
    }
}

fn load_searchable_sources(db_path: &Path) -> Result<SearchableSources, String> {
    let conn = open_db(db_path)?;
    let mut stmt = conn
        .prepare("SELECT id, modality FROM knowledge_sources WHERE status = 'ready'")
        .map_err(|e| format!("Failed to prepare searchable Knowledge source query: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let modality: String = row.get(1)?;
            Ok((id, KnowledgeModality::from_db(&modality)))
        })
        .map_err(|e| format!("Failed to query searchable Knowledge sources: {}", e))?;

    let mut searchable_sources = SearchableSources::default();
    for row in rows {
        let (source_id, modality) =
            row.map_err(|e| format!("Failed to decode searchable Knowledge source: {}", e))?;
        searchable_sources.ready_source_ids.insert(source_id);
        if modality == KnowledgeModality::Image {
            searchable_sources.has_image_sources = true;
        } else {
            searchable_sources.has_text_sources = true;
        }
    }

    Ok(searchable_sources)
}

fn filter_text_search_rows(
    rows: Vec<TextSearchRow>,
    searchable_sources: &SearchableSources,
) -> Vec<TextSearchRow> {
    rows.into_iter()
        .filter(|row| {
            let is_searchable = searchable_sources.ready_source_ids.contains(&row.source_id);
            if !is_searchable {
                tracing::info!(
                    source_id = %row.source_id,
                    "Skipping stale Knowledge text result for deleted source"
                );
            }
            is_searchable
        })
        .collect()
}

fn filter_image_search_rows(
    rows: Vec<ImageSearchRow>,
    searchable_sources: &SearchableSources,
) -> Vec<ImageSearchRow> {
    rows.into_iter()
        .filter(|row| {
            let is_searchable = searchable_sources.ready_source_ids.contains(&row.source_id);
            if !is_searchable {
                tracing::info!(
                    source_id = %row.source_id,
                    "Skipping stale Knowledge image result for deleted source"
                );
            }
            is_searchable
        })
        .collect()
}

async fn ingest_file_inner(
    manager: &KnowledgeManager,
    db_path: &Path,
    path: &Path,
) -> Result<KnowledgeIngestResult, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Failed to inspect {}: {}", path.display(), e))?;
    let locator = path.to_string_lossy().to_string();
    let display_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| locator.clone());
    let modality = infer_file_modality(path).unwrap_or(KnowledgeModality::Text);
    let hash = hash_file(path)?;
    let source = SourceRecord {
        id: uuid::Uuid::new_v4().to_string(),
        source_kind: KnowledgeSourceKind::File,
        modality: modality.clone(),
        locator,
        display_name,
        mime_type: infer_mime_type(path, &modality),
        file_size_bytes: Some(metadata.len()),
        asset_path: Some(path.to_string_lossy().to_string()),
        content_hash: hash,
        chunk_count: 0,
    };

    let file_source_unchanged = {
        let conn = open_db(db_path)?;
        source_unchanged(&conn, &source)?
    };
    if let Some(existing_source) = file_source_unchanged {
        return Ok(KnowledgeIngestResult {
            source_id: Some(existing_source.id),
            display_name: source.display_name,
            modality: source.modality,
            status: "skipped".to_string(),
            chunk_count: existing_source.chunk_count,
            error: None,
        });
    }

    match modality {
        KnowledgeModality::Image => {
            manager.ensure_runtime_components(None, false, true).await?;
            let image_embeddings = {
                let runtime_guard = manager.runtime.lock().await;
                let runtime = &*runtime_guard;
                let image_embedder = runtime
                    .image_embedder
                    .as_ref()
                    .ok_or_else(|| "Knowledge image runtime is unavailable.".to_string())?;
                embed_file(path, image_embedder, None, None)
                    .await
                    .map_err(|e| format!("Failed to ingest image {}: {}", path.display(), e))?
                    .ok_or_else(|| {
                        format!("No image embeddings were produced for {}", path.display())
                    })?
            };
            let chunk_count = write_image_embeddings(manager, &source, image_embeddings).await?;
            let mut finalized_source = source.clone();
            finalized_source.chunk_count = chunk_count;
            persist_replacement_source_with_cleanup(manager, db_path, &finalized_source).await?;
            Ok(KnowledgeIngestResult {
                source_id: Some(finalized_source.id),
                display_name: finalized_source.display_name,
                modality: finalized_source.modality,
                status: "indexed".to_string(),
                chunk_count,
                error: None,
            })
        }
        KnowledgeModality::Audio => {
            manager.ensure_runtime_components(None, true, false).await?;
            let audio_embeddings = {
                let runtime_guard = manager.runtime.lock().await;
                let runtime = &*runtime_guard;
                let text_embedder = runtime
                    .text_embedder
                    .as_ref()
                    .ok_or_else(|| "Knowledge text runtime is unavailable.".to_string())?;
                let mut decoder = AudioDecoderModel::from_pretrained(
                    Some(AUDIO_MODEL_ID),
                    Some("main"),
                    "small",
                    false,
                )
                .map_err(|e| format!("Failed to load audio decoder: {}", e))?;
                emb_audio(
                    path,
                    &mut decoder,
                    text_embedder,
                    Some(&runtime.text_config),
                )
                .await
                .map_err(|e| format!("Failed to transcribe audio {}: {}", path.display(), e))?
                .ok_or_else(|| {
                    format!(
                        "No transcript embeddings were produced for {}",
                        path.display()
                    )
                })?
            };
            let chunk_count = write_text_embeddings(manager, &source, audio_embeddings).await?;
            let mut finalized_source = source.clone();
            finalized_source.chunk_count = chunk_count;
            persist_replacement_source_with_cleanup(manager, db_path, &finalized_source).await?;
            Ok(KnowledgeIngestResult {
                source_id: Some(finalized_source.id),
                display_name: finalized_source.display_name,
                modality: finalized_source.modality,
                status: "indexed".to_string(),
                chunk_count,
                error: None,
            })
        }
        _ => {
            manager.ensure_runtime_components(None, true, false).await?;
            let text_embeddings = {
                let runtime_guard = manager.runtime.lock().await;
                let runtime = &*runtime_guard;
                let text_embedder = runtime
                    .text_embedder
                    .as_ref()
                    .ok_or_else(|| "Knowledge text runtime is unavailable.".to_string())?;
                embed_file(path, text_embedder, Some(&runtime.text_config), None)
                    .await
                    .map_err(|e| format!("Failed to ingest {}: {}", path.display(), e))?
                    .ok_or_else(|| {
                        format!("No Knowledge text was extracted from {}", path.display())
                    })?
            };
            let chunk_count = write_text_embeddings(manager, &source, text_embeddings).await?;
            if chunk_count == 0 {
                return Err(format!(
                    "File type {} did not produce Knowledge chunks.",
                    path.display()
                ));
            }
            let mut finalized_source = source.clone();
            finalized_source.chunk_count = chunk_count;
            persist_replacement_source_with_cleanup(manager, db_path, &finalized_source).await?;
            Ok(KnowledgeIngestResult {
                source_id: Some(finalized_source.id),
                display_name: finalized_source.display_name,
                modality: finalized_source.modality,
                status: "indexed".to_string(),
                chunk_count,
                error: None,
            })
        }
    }
}

fn infer_file_modality(path: &Path) -> Option<KnowledgeModality> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())?;

    if matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff"
    ) {
        return Some(KnowledgeModality::Image);
    }

    if matches!(
        ext.as_str(),
        "wav" | "mp3" | "m4a" | "aac" | "flac" | "ogg" | "opus"
    ) {
        return Some(KnowledgeModality::Audio);
    }

    Some(KnowledgeModality::Text)
}

fn infer_mime_type(path: &Path, modality: &KnowledgeModality) -> Option<String> {
    match modality {
        KnowledgeModality::Image => path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!("image/{}", value.to_ascii_lowercase())),
        KnowledgeModality::Audio => path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!("audio/{}", value.to_ascii_lowercase())),
        KnowledgeModality::Webpage => Some("text/html".to_string()),
        KnowledgeModality::Text => Some("text/plain".to_string()),
    }
}

fn hash_file(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open {} for hashing: {}", path.display(), e))?;
    hash_reader(BufReader::new(file))
        .map_err(|e| format!("Failed to hash {}: {}", path.display(), e))
}

#[cfg(test)]
fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn hash_reader(mut reader: impl Read) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn embed_text(item: &EmbedData) -> Option<&str> {
    item.text
        .as_deref()
        .or_else(|| {
            item.metadata
                .as_ref()
                .and_then(|metadata| metadata.get("text").map(String::as_str))
        })
        .filter(|text| !text.is_empty())
}

fn hash_embed_texts<'a>(embeddings: impl IntoIterator<Item = &'a EmbedData>) -> Option<String> {
    let mut hasher = Sha256::new();
    let mut saw_text = false;
    for item in embeddings {
        let Some(text) = embed_text(item) else {
            continue;
        };
        if saw_text {
            hasher.update(b"\n");
        }
        hasher.update(text.as_bytes());
        saw_text = true;
    }

    saw_text.then(|| format!("{:x}", hasher.finalize()))
}

fn source_unchanged(
    conn: &rusqlite::Connection,
    source: &SourceRecord,
) -> Result<Option<ExistingSourceMatch>, String> {
    let existing_source = conn
        .query_row(
            "SELECT id, chunk_count
             FROM knowledge_sources
             WHERE locator = ?1 AND content_hash = ?2 AND status = 'ready'
             ORDER BY updated_at DESC
             LIMIT 1",
            params![source.locator, source.content_hash],
            |row| {
                let chunk_count: i64 = row.get(1)?;
                Ok(ExistingSourceMatch {
                    id: row.get(0)?,
                    chunk_count: usize::try_from(chunk_count.max(0)).unwrap_or_default(),
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to inspect Knowledge source hash: {}", e))?;
    Ok(existing_source)
}

fn write_source_record(conn: &rusqlite::Connection, source: &SourceRecord) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO knowledge_sources (
            id, source_kind, modality, locator, display_name, mime_type, file_size_bytes,
            asset_path, content_hash, status, error, chunk_count, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'indexing', NULL, ?10, ?11, ?11)
         ON CONFLICT(id) DO UPDATE SET
            source_kind = excluded.source_kind,
            modality = excluded.modality,
            locator = excluded.locator,
            display_name = excluded.display_name,
            mime_type = excluded.mime_type,
            file_size_bytes = excluded.file_size_bytes,
            asset_path = excluded.asset_path,
            content_hash = excluded.content_hash,
            status = 'indexing',
            error = NULL,
            chunk_count = excluded.chunk_count,
            updated_at = excluded.updated_at",
        params![
            source.id,
            match source.source_kind {
                KnowledgeSourceKind::File => "file",
                KnowledgeSourceKind::Url => "url",
            },
            source.modality.as_str(),
            source.locator,
            source.display_name,
            source.mime_type,
            source.file_size_bytes.map(|value| value as i64),
            source.asset_path,
            source.content_hash,
            source.chunk_count as i64,
            now,
        ],
    )
    .map_err(|e| format!("Failed to upsert Knowledge source: {}", e))?;
    Ok(())
}

fn finalize_source(
    conn: &rusqlite::Connection,
    source_id: &str,
    chunk_count: usize,
) -> Result<(), String> {
    conn.execute(
        "UPDATE knowledge_sources
         SET status = 'ready', error = NULL, chunk_count = ?2, updated_at = ?3
         WHERE id = ?1",
        params![
            source_id,
            chunk_count as i64,
            chrono::Utc::now().to_rfc3339()
        ],
    )
    .map_err(|e| format!("Failed to finalize Knowledge source: {}", e))?;
    Ok(())
}

fn stale_source_ids_for_locator(
    conn: &rusqlite::Connection,
    locator: &str,
    active_source_id: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM knowledge_sources WHERE locator = ?1 AND id != ?2")
        .map_err(|e| format!("Failed to inspect stale Knowledge sources: {}", e))?;
    let rows = stmt
        .query_map(params![locator, active_source_id], |row| row.get(0))
        .map_err(|e| format!("Failed to query stale Knowledge sources: {}", e))?;

    rows.collect::<Result<Vec<String>, _>>()
        .map_err(|e| format!("Failed to decode stale Knowledge sources: {}", e))
}

fn commit_source_replacement(
    conn: &rusqlite::Connection,
    source: &SourceRecord,
) -> Result<Vec<String>, String> {
    conn.execute_batch("BEGIN IMMEDIATE TRANSACTION;")
        .map_err(|e| format!("Failed to begin Knowledge source transaction: {}", e))?;

    let result = (|| {
        let stale_source_ids = stale_source_ids_for_locator(conn, &source.locator, &source.id)?;
        write_source_record(conn, source)?;
        finalize_source(conn, &source.id, source.chunk_count)?;
        conn.execute(
            "DELETE FROM knowledge_sources WHERE locator = ?1 AND id != ?2",
            params![source.locator, source.id],
        )
        .map_err(|e| format!("Failed to replace stale Knowledge sources: {}", e))?;
        Ok(stale_source_ids)
    })();

    match result {
        Ok(stale_source_ids) => conn
            .execute_batch("COMMIT;")
            .map_err(|e| {
                let _ = conn.execute_batch("ROLLBACK;");
                format!("Failed to commit Knowledge source transaction: {}", e)
            })
            .map(|_| stale_source_ids),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

async fn delete_source_rows_by_ids(
    manager: &KnowledgeManager,
    source_ids: &[String],
) -> Result<(), String> {
    for source_id in source_ids {
        delete_existing_source_rows(manager, source_id).await?;
    }
    Ok(())
}

async fn persist_replacement_source(
    manager: &KnowledgeManager,
    db_path: &Path,
    source: &SourceRecord,
) -> Result<(), String> {
    let stale_source_ids = {
        let conn = open_db(db_path)?;
        commit_source_replacement(&conn, source)?
    };

    if let Err(error) = delete_source_rows_by_ids(manager, &stale_source_ids).await {
        tracing::warn!(
            locator = %source.locator,
            source_id = %source.id,
            error = %error,
            "Failed to remove stale Knowledge rows after replacement"
        );
    }

    Ok(())
}

async fn persist_replacement_source_with_cleanup(
    manager: &KnowledgeManager,
    db_path: &Path,
    source: &SourceRecord,
) -> Result<(), String> {
    match persist_replacement_source(manager, db_path, source).await {
        Ok(()) => Ok(()),
        Err(error) => {
            if let Err(cleanup_error) = delete_existing_source_rows(manager, &source.id).await {
                tracing::warn!(
                    source_id = %source.id,
                    locator = %source.locator,
                    cleanup_error = %cleanup_error,
                    "Failed to cleanup Knowledge rows after replacement persistence failure"
                );
            }
            Err(error)
        }
    }
}

async fn delete_existing_source_rows(
    manager: &KnowledgeManager,
    source_id: &str,
) -> Result<(), String> {
    manager
        .ensure_runtime_components(None, false, false)
        .await?;
    let runtime_guard = manager.runtime.lock().await;
    let db = runtime_guard
        .db
        .as_ref()
        .ok_or_else(|| "Knowledge database is unavailable.".to_string())?;

    tracing::info!(source_id, "Deleting existing Knowledge rows for source");

    if table_exists(db, TEXT_TABLE).await? {
        db.open_table(TEXT_TABLE)
            .execute()
            .await
            .map_err(|e| format!("Failed to open Knowledge text table: {}", e))?
            .delete(&format!("source_id = '{}'", escape_sql_string(source_id)))
            .await
            .map_err(|e| format!("Failed to delete existing Knowledge text rows: {}", e))?;
    }

    if table_exists(db, IMAGE_TABLE).await? {
        db.open_table(IMAGE_TABLE)
            .execute()
            .await
            .map_err(|e| format!("Failed to open Knowledge image table: {}", e))?
            .delete(&format!("source_id = '{}'", escape_sql_string(source_id)))
            .await
            .map_err(|e| format!("Failed to delete existing Knowledge image rows: {}", e))?;
    }

    Ok(())
}

fn text_row_from_embedding(
    source: &SourceRecord,
    chunk_index: usize,
    item: EmbedData,
) -> Result<TextChunkInsert, String> {
    let text = embed_text(&item).unwrap_or_default().to_string();
    let embedding = item
        .embedding
        .to_dense()
        .map_err(|e| format!("Failed to convert text embedding: {}", e))?;
    Ok(TextChunkInsert {
        source_id: source.id.clone(),
        chunk_id: uuid::Uuid::new_v4().to_string(),
        chunk_index: i32::try_from(chunk_index).unwrap_or_default(),
        text,
        modality: source.modality.clone(),
        locator: source.locator.clone(),
        display_name: source.display_name.clone(),
        mime_type: source.mime_type.clone(),
        asset_path: source.asset_path.clone(),
        embedding,
    })
}

fn image_row_from_embedding(
    source: &SourceRecord,
    item: EmbedData,
) -> Result<ImageAssetInsert, String> {
    let embedding = item
        .embedding
        .to_dense()
        .map_err(|e| format!("Failed to convert image embedding: {}", e))?;
    Ok(ImageAssetInsert {
        source_id: source.id.clone(),
        asset_id: uuid::Uuid::new_v4().to_string(),
        locator: source.locator.clone(),
        display_name: source.display_name.clone(),
        mime_type: source.mime_type.clone(),
        asset_path: source.asset_path.clone(),
        embedding,
    })
}

async fn write_text_embeddings(
    manager: &KnowledgeManager,
    source: &SourceRecord,
    embeddings: Vec<EmbedData>,
) -> Result<usize, String> {
    if embeddings.is_empty() {
        return Ok(0);
    }

    manager
        .ensure_runtime_components(None, false, false)
        .await?;

    let expected_rows = embeddings.len();
    let mut batch = Vec::with_capacity(KNOWLEDGE_WRITE_BATCH_SIZE);
    let mut batch_count = 0usize;
    let mut written_rows = 0usize;

    for (chunk_index, item) in embeddings.into_iter().enumerate() {
        batch.push(text_row_from_embedding(source, chunk_index, item)?);
        if batch.len() == KNOWLEDGE_WRITE_BATCH_SIZE {
            batch_count += 1;
            let batch_rows = batch.len();
            tracing::info!(
                source_id = %source.id,
                modality = source.modality.as_str(),
                batch_index = batch_count,
                batch_rows,
                "Writing Knowledge text batch"
            );
            write_text_rows(manager, std::mem::take(&mut batch)).await?;
            written_rows += batch_rows;
        }
    }

    if !batch.is_empty() {
        batch_count += 1;
        let batch_rows = batch.len();
        tracing::info!(
            source_id = %source.id,
            modality = source.modality.as_str(),
            batch_index = batch_count,
            batch_rows,
            "Writing Knowledge text batch"
        );
        write_text_rows(manager, batch).await?;
        written_rows += batch_rows;
    }

    tracing::info!(
        source_id = %source.id,
        modality = source.modality.as_str(),
        expected_rows,
        written_rows,
        batch_count,
        "Finished Knowledge text embedding writes"
    );

    Ok(written_rows)
}

async fn write_image_embeddings(
    manager: &KnowledgeManager,
    source: &SourceRecord,
    embeddings: Vec<EmbedData>,
) -> Result<usize, String> {
    if embeddings.is_empty() {
        return Ok(0);
    }

    manager
        .ensure_runtime_components(None, false, false)
        .await?;

    let expected_rows = embeddings.len();
    let mut batch = Vec::with_capacity(KNOWLEDGE_WRITE_BATCH_SIZE);
    let mut batch_count = 0usize;
    let mut written_rows = 0usize;

    for item in embeddings {
        batch.push(image_row_from_embedding(source, item)?);
        if batch.len() == KNOWLEDGE_WRITE_BATCH_SIZE {
            batch_count += 1;
            let batch_rows = batch.len();
            tracing::info!(
                source_id = %source.id,
                modality = source.modality.as_str(),
                batch_index = batch_count,
                batch_rows,
                "Writing Knowledge image batch"
            );
            write_image_rows(manager, std::mem::take(&mut batch)).await?;
            written_rows += batch_rows;
        }
    }

    if !batch.is_empty() {
        batch_count += 1;
        let batch_rows = batch.len();
        tracing::info!(
            source_id = %source.id,
            modality = source.modality.as_str(),
            batch_index = batch_count,
            batch_rows,
            "Writing Knowledge image batch"
        );
        write_image_rows(manager, batch).await?;
        written_rows += batch_rows;
    }

    tracing::info!(
        source_id = %source.id,
        modality = source.modality.as_str(),
        expected_rows,
        written_rows,
        batch_count,
        "Finished Knowledge image embedding writes"
    );

    Ok(written_rows)
}

async fn write_text_rows(
    manager: &KnowledgeManager,
    rows: Vec<TextChunkInsert>,
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }

    let runtime_guard = manager.runtime.lock().await;
    let db = runtime_guard
        .db
        .as_ref()
        .ok_or_else(|| "Knowledge database is unavailable.".to_string())?;
    let batch = text_rows_to_batch(&rows)?;

    if table_exists(db, TEXT_TABLE).await? {
        let table = db
            .open_table(TEXT_TABLE)
            .execute()
            .await
            .map_err(|e| format!("Failed to open Knowledge text table: {}", e))?;
        table
            .add(batch)
            .execute()
            .await
            .map_err(|e| format!("Failed to append Knowledge text rows: {}", e))?;
        let total_rows = count_rows_if_exists(db, TEXT_TABLE).await?;
        if total_rows >= MIN_VECTOR_INDEX_ROWS {
            ensure_vector_index(&table, "embedding", "Knowledge vector index").await?;
        }
    } else {
        let table = db
            .create_table(TEXT_TABLE, batch)
            .execute()
            .await
            .map_err(|e| format!("Failed to create Knowledge text table: {}", e))?;
        if rows.len() >= MIN_VECTOR_INDEX_ROWS {
            ensure_vector_index(&table, "embedding", "Knowledge vector index").await?;
        }
        table
            .create_index(&["text"], Index::FTS(FtsIndexBuilder::default()))
            .execute()
            .await
            .map_err(|e| format!("Failed to create Knowledge full-text index: {}", e))?;
    }

    Ok(())
}

async fn write_image_rows(
    manager: &KnowledgeManager,
    rows: Vec<ImageAssetInsert>,
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }

    let runtime_guard = manager.runtime.lock().await;
    let db = runtime_guard
        .db
        .as_ref()
        .ok_or_else(|| "Knowledge database is unavailable.".to_string())?;
    let batch = image_rows_to_batch(&rows)?;

    if table_exists(db, IMAGE_TABLE).await? {
        let table = db
            .open_table(IMAGE_TABLE)
            .execute()
            .await
            .map_err(|e| format!("Failed to open Knowledge image table: {}", e))?;
        table
            .add(batch)
            .execute()
            .await
            .map_err(|e| format!("Failed to append Knowledge image rows: {}", e))?;
        let total_rows = count_rows_if_exists(db, IMAGE_TABLE).await?;
        if total_rows >= MIN_VECTOR_INDEX_ROWS {
            ensure_vector_index(&table, "embedding", "Knowledge image vector index").await?;
        }
    } else {
        let table = db
            .create_table(IMAGE_TABLE, batch)
            .execute()
            .await
            .map_err(|e| format!("Failed to create Knowledge image table: {}", e))?;
        if rows.len() >= MIN_VECTOR_INDEX_ROWS {
            ensure_vector_index(&table, "embedding", "Knowledge image vector index").await?;
        }
    }

    Ok(())
}

async fn ensure_vector_index(
    table: &lancedb::table::Table,
    column: &str,
    label: &str,
) -> Result<(), String> {
    match table
        .create_index(&[column], Index::Auto)
        .replace(false)
        .execute()
        .await
    {
        Ok(()) => Ok(()),
        Err(error) if error.to_string().contains("already exists") => Ok(()),
        Err(error) => Err(format!("Failed to create {}: {}", label, error)),
    }
}

fn text_rows_to_batch(rows: &[TextChunkInsert]) -> Result<RecordBatch, String> {
    let dim = rows
        .first()
        .map(|row| row.embedding.len())
        .ok_or_else(|| "Knowledge text rows are empty.".to_string())?;
    let schema = Arc::new(Schema::new(vec![
        Field::new("source_id", DataType::Utf8, false),
        Field::new("chunk_id", DataType::Utf8, false),
        Field::new("chunk_index", DataType::Int32, false),
        Field::new("text", DataType::Utf8, false),
        Field::new("modality", DataType::Utf8, false),
        Field::new("locator", DataType::Utf8, false),
        Field::new("display_name", DataType::Utf8, false),
        Field::new("mime_type", DataType::Utf8, true),
        Field::new("asset_path", DataType::Utf8, true),
        Field::new(
            "embedding",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                dim as i32,
            ),
            true,
        ),
    ]));

    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|row| row.source_id.as_str()),
            )) as ArrayRef,
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|row| row.chunk_id.as_str()),
            )),
            Arc::new(Int32Array::from_iter_values(
                rows.iter().map(|row| row.chunk_index),
            )),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|row| row.text.as_str()),
            )),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|row| row.modality.as_str()),
            )),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|row| row.locator.as_str()),
            )),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|row| row.display_name.as_str()),
            )),
            Arc::new(StringArray::from(
                rows.iter()
                    .map(|row| row.mime_type.as_deref())
                    .collect::<Vec<_>>(),
            )),
            Arc::new(StringArray::from(
                rows.iter()
                    .map(|row| row.asset_path.as_deref())
                    .collect::<Vec<_>>(),
            )),
            Arc::new(
                FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
                    rows.iter().map(|row| {
                        Some(row.embedding.iter().copied().map(Some).collect::<Vec<_>>())
                    }),
                    dim as i32,
                ),
            ),
        ],
    )
    .map_err(|e| format!("Failed to build Knowledge text batch: {}", e))
}

fn image_rows_to_batch(rows: &[ImageAssetInsert]) -> Result<RecordBatch, String> {
    let dim = rows
        .first()
        .map(|row| row.embedding.len())
        .ok_or_else(|| "Knowledge image rows are empty.".to_string())?;
    let schema = Arc::new(Schema::new(vec![
        Field::new("source_id", DataType::Utf8, false),
        Field::new("asset_id", DataType::Utf8, false),
        Field::new("locator", DataType::Utf8, false),
        Field::new("display_name", DataType::Utf8, false),
        Field::new("mime_type", DataType::Utf8, true),
        Field::new("asset_path", DataType::Utf8, true),
        Field::new(
            "embedding",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                dim as i32,
            ),
            true,
        ),
    ]));

    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|row| row.source_id.as_str()),
            )) as ArrayRef,
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|row| row.asset_id.as_str()),
            )),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|row| row.locator.as_str()),
            )),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|row| row.display_name.as_str()),
            )),
            Arc::new(StringArray::from(
                rows.iter()
                    .map(|row| row.mime_type.as_deref())
                    .collect::<Vec<_>>(),
            )),
            Arc::new(StringArray::from(
                rows.iter()
                    .map(|row| row.asset_path.as_deref())
                    .collect::<Vec<_>>(),
            )),
            Arc::new(
                FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
                    rows.iter().map(|row| {
                        Some(row.embedding.iter().copied().map(Some).collect::<Vec<_>>())
                    }),
                    dim as i32,
                ),
            ),
        ],
    )
    .map_err(|e| format!("Failed to build Knowledge image batch: {}", e))
}

async fn table_exists(db: &LanceConnection, table_name: &str) -> Result<bool, String> {
    db.table_names()
        .execute()
        .await
        .map(|tables| tables.iter().any(|name| name == table_name))
        .map_err(|e| format!("Failed to inspect Knowledge tables: {}", e))
}

async fn count_rows_if_exists(db: &LanceConnection, table_name: &str) -> Result<usize, String> {
    if !table_exists(db, table_name).await? {
        return Ok(0);
    }
    db.open_table(table_name)
        .execute()
        .await
        .map_err(|e| format!("Failed to open Knowledge table {}: {}", table_name, e))?
        .count_rows(None)
        .await
        .map_err(|e| format!("Failed to count Knowledge rows in {}: {}", table_name, e))
}

fn dense_embedding(data: &EmbedData) -> Result<Vec<f32>, String> {
    data.embedding
        .to_dense()
        .map_err(|e| format!("Failed to materialize Knowledge embedding: {}", e))
}

async fn search_text_rows(
    db: &LanceConnection,
    query: &str,
    query_vector: &[f32],
    limit: usize,
) -> Result<Vec<TextSearchRow>, String> {
    if !table_exists(db, TEXT_TABLE).await? {
        return Ok(Vec::new());
    }

    let table = db
        .open_table(TEXT_TABLE)
        .execute()
        .await
        .map_err(|e| format!("Failed to open Knowledge text table: {}", e))?;

    let mut stream = table
        .query()
        .full_text_search(FullTextSearchQuery::new(query.to_string()))
        .nearest_to(query_vector)
        .map_err(|e| format!("Failed to prepare hybrid Knowledge query: {}", e))?
        .limit(limit)
        .execute_hybrid(QueryExecutionOptions::default())
        .await
        .map_err(|e| format!("Failed to execute hybrid Knowledge query: {}", e))?;

    let mut rows = Vec::new();
    while let Some(batch) = stream
        .try_next()
        .await
        .map_err(|e| format!("Failed to stream Knowledge text results: {}", e))?
    {
        rows.extend(read_text_search_rows(&batch)?);
    }
    Ok(rows)
}

async fn search_image_rows(
    db: &LanceConnection,
    query_vector: &[f32],
    limit: usize,
) -> Result<Vec<ImageSearchRow>, String> {
    if !table_exists(db, IMAGE_TABLE).await? {
        return Ok(Vec::new());
    }

    let table = db
        .open_table(IMAGE_TABLE)
        .execute()
        .await
        .map_err(|e| format!("Failed to open Knowledge image table: {}", e))?;

    let mut stream = table
        .query()
        .nearest_to(query_vector)
        .map_err(|e| format!("Failed to prepare Knowledge image query: {}", e))?
        .limit(limit)
        .execute()
        .await
        .map_err(|e| format!("Failed to execute Knowledge image query: {}", e))?;

    let mut rows = Vec::new();
    while let Some(batch) = stream
        .try_next()
        .await
        .map_err(|e| format!("Failed to stream Knowledge image results: {}", e))?
    {
        rows.extend(read_image_search_rows(&batch)?);
    }
    Ok(rows)
}

fn read_text_search_rows(batch: &RecordBatch) -> Result<Vec<TextSearchRow>, String> {
    let source_ids = column_strings_required(batch, "source_id")?;
    let chunk_indices = column_i32_required(batch, "chunk_index")?;
    let texts = column_strings_required(batch, "text")?;
    let modalities = column_strings_required(batch, "modality")?;
    let locators = column_strings_required(batch, "locator")?;
    let display_names = column_strings_required(batch, "display_name")?;
    let asset_paths = column_strings_optional(batch, "asset_path")?;
    let scores = column_scores(batch)?;

    Ok((0..batch.num_rows())
        .map(|index| TextSearchRow {
            source_id: source_ids[index].clone(),
            chunk_index: chunk_indices[index],
            text: texts[index].clone(),
            modality: KnowledgeModality::from_db(&modalities[index]),
            locator: locators[index].clone(),
            display_name: display_names[index].clone(),
            asset_path: asset_paths[index].clone(),
            score: scores[index],
        })
        .collect())
}

fn read_image_search_rows(batch: &RecordBatch) -> Result<Vec<ImageSearchRow>, String> {
    let source_ids = column_strings_required(batch, "source_id")?;
    let locators = column_strings_required(batch, "locator")?;
    let display_names = column_strings_required(batch, "display_name")?;
    let mime_types = column_strings_optional(batch, "mime_type")?;
    let asset_paths = column_strings_optional(batch, "asset_path")?;
    let scores = column_scores(batch)?;

    Ok((0..batch.num_rows())
        .map(|index| ImageSearchRow {
            source_id: source_ids[index].clone(),
            locator: locators[index].clone(),
            display_name: display_names[index].clone(),
            mime_type: mime_types[index].clone(),
            asset_path: asset_paths[index].clone(),
            score: scores[index],
        })
        .collect())
}

fn column_strings_required(batch: &RecordBatch, name: &str) -> Result<Vec<String>, String> {
    let column = batch
        .column_by_name(name)
        .ok_or_else(|| format!("Missing Knowledge result column {}", name))?;
    let values = column
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or_else(|| format!("Unexpected type for Knowledge result column {}", name))?;
    Ok((0..batch.num_rows())
        .map(|index| values.value(index).to_string())
        .collect())
}

fn column_strings_optional(batch: &RecordBatch, name: &str) -> Result<Vec<Option<String>>, String> {
    let Some(column) = batch.column_by_name(name) else {
        return Ok(vec![None; batch.num_rows()]);
    };
    let values = column
        .as_any()
        .downcast_ref::<StringArray>()
        .ok_or_else(|| format!("Unexpected type for Knowledge result column {}", name))?;
    Ok(values
        .iter()
        .map(|value| value.map(str::to_string))
        .collect())
}

fn column_i32_required(batch: &RecordBatch, name: &str) -> Result<Vec<i32>, String> {
    let column = batch
        .column_by_name(name)
        .ok_or_else(|| format!("Missing Knowledge result column {}", name))?;
    let values = column
        .as_any()
        .downcast_ref::<Int32Array>()
        .ok_or_else(|| format!("Unexpected type for Knowledge result column {}", name))?;
    Ok((0..values.len()).map(|index| values.value(index)).collect())
}

fn column_scores(batch: &RecordBatch) -> Result<Vec<f32>, String> {
    for name in ["_relevance_score", "_score", "_distance"] {
        if let Some(column) = batch.column_by_name(name) {
            let values = column
                .as_any()
                .downcast_ref::<Float32Array>()
                .ok_or_else(|| format!("Unexpected type for Knowledge score column {}", name))?;
            return Ok((0..values.len()).map(|index| values.value(index)).collect());
        }
    }

    Ok(vec![0.0; batch.num_rows()])
}

fn escape_sql_string(value: &str) -> String {
    value.replace('\'', "''")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut output = String::new();
    for ch in value.chars().take(max_chars) {
        output.push(ch);
    }
    if value.chars().count() > max_chars {
        output.push('…');
    }
    output
}

pub fn summarize_text_snippets(results: &KnowledgeSearchResults) -> Option<String> {
    if results.text_snippets.is_empty() {
        return None;
    }

    let mut total_chars = 0usize;
    let mut lines = Vec::new();
    for item in &results.text_snippets {
        if total_chars >= MAX_PROMPT_TEXT_TOTAL_CHARS {
            break;
        }

        let snippet = truncate_chars(&item.snippet, MAX_PROMPT_TEXT_SNIPPET_CHARS);
        total_chars += snippet.chars().count();
        lines.push(format!("[{}] {}", item.citation.display_name, snippet));
    }

    if lines.is_empty() {
        None
    } else {
        Some(format!(
            "Relevant knowledge sources:\n{}\n\nUse this context when it is relevant to the user's request.",
            lines.join("\n\n")
        ))
    }
}

pub fn audio_prompt_asset(results: &KnowledgeSearchResults) -> Option<&RetrievedAudio> {
    results.audio.as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage;
    use embed_anything::embeddings::embed::EmbeddingResult;
    use std::collections::HashMap;
    use tokio::runtime::Runtime;
    use uuid::Uuid;

    fn temp_test_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("friday-{}-{}", prefix, Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp test dir");
        dir
    }

    fn make_text_embed(text: &str, embedding: Vec<f32>) -> EmbedData {
        EmbedData::new(
            EmbeddingResult::DenseVector(embedding),
            Some(text.to_string()),
            None,
        )
    }

    fn make_metadata_text_embed(text: &str, embedding: Vec<f32>) -> EmbedData {
        let mut metadata = HashMap::new();
        metadata.insert("text".to_string(), text.to_string());
        EmbedData::new(
            EmbeddingResult::DenseVector(embedding),
            None,
            Some(metadata),
        )
    }

    fn make_image_embed(embedding: Vec<f32>) -> EmbedData {
        EmbedData::new(EmbeddingResult::DenseVector(embedding), None, None)
    }

    fn test_source(modality: KnowledgeModality, asset_path: Option<String>) -> SourceRecord {
        SourceRecord {
            id: Uuid::new_v4().to_string(),
            source_kind: KnowledgeSourceKind::File,
            modality,
            locator: "/tmp/source".to_string(),
            display_name: "source".to_string(),
            mime_type: Some("text/plain".to_string()),
            file_size_bytes: None,
            asset_path,
            content_hash: "hash".to_string(),
            chunk_count: 0,
        }
    }

    #[test]
    fn truncate_chars_adds_ellipsis() {
        assert_eq!(truncate_chars("abcdef", 3), "abc…");
        assert_eq!(truncate_chars("abc", 3), "abc");
    }

    #[test]
    fn hash_bytes_is_stable() {
        assert_eq!(
            hash_bytes(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn build_search_plan_uses_only_available_modalities() {
        assert_eq!(
            build_search_plan(4, 0),
            SearchPlan {
                use_text: true,
                use_image: false,
            }
        );
        assert_eq!(
            build_search_plan(0, 3),
            SearchPlan {
                use_text: false,
                use_image: true,
            }
        );
        assert_eq!(
            build_search_plan(2, 5),
            SearchPlan {
                use_text: true,
                use_image: true,
            }
        );
        assert_eq!(
            build_search_plan(0, 0),
            SearchPlan {
                use_text: false,
                use_image: false,
            }
        );
    }

    #[test]
    fn filter_search_rows_skips_deleted_sources() {
        let searchable_sources = SearchableSources {
            ready_source_ids: HashSet::from(["active".to_string()]),
            has_text_sources: true,
            has_image_sources: true,
        };

        let text_rows = filter_text_search_rows(
            vec![
                TextSearchRow {
                    source_id: "active".to_string(),
                    chunk_index: 0,
                    text: "keep me".to_string(),
                    modality: KnowledgeModality::Text,
                    locator: "/tmp/active.txt".to_string(),
                    display_name: "active.txt".to_string(),
                    asset_path: None,
                    score: 0.9,
                },
                TextSearchRow {
                    source_id: "deleted".to_string(),
                    chunk_index: 1,
                    text: "drop me".to_string(),
                    modality: KnowledgeModality::Text,
                    locator: "/tmp/deleted.txt".to_string(),
                    display_name: "deleted.txt".to_string(),
                    asset_path: None,
                    score: 0.2,
                },
            ],
            &searchable_sources,
        );
        assert_eq!(text_rows.len(), 1);
        assert_eq!(text_rows[0].source_id, "active");

        let image_rows = filter_image_search_rows(
            vec![
                ImageSearchRow {
                    source_id: "deleted".to_string(),
                    locator: "/tmp/deleted.png".to_string(),
                    display_name: "deleted.png".to_string(),
                    mime_type: Some("image/png".to_string()),
                    asset_path: Some("/tmp/deleted.png".to_string()),
                    score: 0.4,
                },
                ImageSearchRow {
                    source_id: "active".to_string(),
                    locator: "/tmp/active.png".to_string(),
                    display_name: "active.png".to_string(),
                    mime_type: Some("image/png".to_string()),
                    asset_path: Some("/tmp/active.png".to_string()),
                    score: 0.8,
                },
            ],
            &searchable_sources,
        );
        assert_eq!(image_rows.len(), 1);
        assert_eq!(image_rows[0].source_id, "active");
    }

    #[test]
    fn knowledge_runtime_idle_requires_timeout_and_zero_active_uses() {
        let now = Instant::now();
        assert!(!knowledge_runtime_idle(now, 0, now));
        assert!(!knowledge_runtime_idle(
            now - KNOWLEDGE_RUNTIME_IDLE_TIMEOUT,
            1,
            now
        ));
        assert!(knowledge_runtime_idle(
            now - KNOWLEDGE_RUNTIME_IDLE_TIMEOUT,
            0,
            now
        ));
    }

    #[test]
    fn low_signal_queries_skip_knowledge_search() {
        assert!(should_skip_knowledge_query(""));
        assert!(should_skip_knowledge_query("hi"));
        assert!(should_skip_knowledge_query("OK"));
        assert!(!should_skip_knowledge_query(
            "Summarize the local product notes"
        ));
    }

    #[test]
    fn hash_file_matches_hash_bytes() {
        let dir = temp_test_dir("knowledge-hash");
        let path = dir.join("notes.txt");
        let content = "Friday keeps knowledge local.\n".repeat(256);
        std::fs::write(&path, &content).expect("fixture file");

        assert_eq!(
            hash_file(&path).expect("stream hash"),
            hash_bytes(content.as_bytes())
        );
    }

    #[test]
    fn hash_embed_texts_is_stable_for_identical_content() {
        let embeddings_a = vec![
            make_text_embed("alpha", vec![1.0, 0.0, 0.0]),
            make_metadata_text_embed("beta", vec![0.0, 1.0, 0.0]),
        ];
        let embeddings_b = vec![
            make_text_embed("alpha", vec![9.0, 9.0, 9.0]),
            make_metadata_text_embed("beta", vec![8.0, 8.0, 8.0]),
        ];

        assert_eq!(
            hash_embed_texts(embeddings_a.iter()),
            hash_embed_texts(embeddings_b.iter())
        );
    }

    #[test]
    fn source_unchanged_returns_persisted_source_metadata() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(include_str!("../../migrations/001_initial.sql"))
            .expect("apply migration 001");
        conn.execute_batch(include_str!("../../migrations/004_knowledge.sql"))
            .expect("apply migration 004");

        conn.execute(
            "INSERT INTO knowledge_sources (
                id, source_kind, modality, locator, display_name, mime_type, file_size_bytes,
                asset_path, content_hash, status, error, chunk_count, created_at, updated_at
            ) VALUES (?1, 'file', 'text', ?2, ?3, 'text/plain', NULL, NULL, ?4, 'ready', NULL, ?5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
            params!["persisted-source", "/tmp/notes.txt", "notes.txt", "hash-1", 9_i64],
        )
        .expect("insert persisted source");

        let candidate = SourceRecord {
            id: "new-source".to_string(),
            source_kind: KnowledgeSourceKind::File,
            modality: KnowledgeModality::Text,
            locator: "/tmp/notes.txt".to_string(),
            display_name: "notes.txt".to_string(),
            mime_type: Some("text/plain".to_string()),
            file_size_bytes: None,
            asset_path: None,
            content_hash: "hash-1".to_string(),
            chunk_count: 0,
        };

        let persisted = source_unchanged(&conn, &candidate)
            .expect("query unchanged source")
            .expect("existing source match");
        assert_eq!(persisted.id, "persisted-source");
        assert_eq!(persisted.chunk_count, 9);
    }

    #[test]
    fn summarize_text_snippets_builds_preface() {
        let results = KnowledgeSearchResults {
            citations: vec![],
            text_snippets: vec![RetrievedTextSnippet {
                citation: KnowledgeCitation {
                    source_id: "src".to_string(),
                    modality: KnowledgeModality::Text,
                    display_name: "notes.md".to_string(),
                    locator: "/tmp/notes.md".to_string(),
                    score: 0.9,
                    chunk_index: Some(0),
                    snippet: Some("Friday stores chats locally.".to_string()),
                },
                snippet: "Friday stores chats locally.".to_string(),
            }],
            images: vec![],
            audio: None,
        };

        let summary = summarize_text_snippets(&results).expect("summary");
        assert!(summary.contains("Relevant knowledge sources:"));
        assert!(summary.contains("[notes.md] Friday stores chats locally."));
    }

    #[test]
    fn write_text_embeddings_batches_rows_and_keeps_results_queryable() {
        let runtime = Runtime::new().expect("tokio runtime");
        let knowledge_root = temp_test_dir("knowledge-text-batches");
        let manager = KnowledgeManager::new();
        manager
            .set_root_dir(knowledge_root)
            .expect("knowledge root");
        let source = test_source(KnowledgeModality::Text, Some("/tmp/source.txt".to_string()));
        let embeddings = (0..130)
            .map(|index| {
                make_text_embed(
                    &format!("alpha chunk {}", index),
                    vec![1.0, index as f32, 0.5],
                )
            })
            .collect::<Vec<_>>();

        let written_rows = runtime
            .block_on(write_text_embeddings(&manager, &source, embeddings))
            .expect("text rows");
        assert_eq!(written_rows, 130);

        let (row_count, search_rows) = runtime.block_on(async {
            let runtime_guard = manager.runtime.lock().await;
            let db = runtime_guard.db.as_ref().expect("db loaded");
            let row_count = count_rows_if_exists(db, TEXT_TABLE)
                .await
                .expect("row count");
            let search_rows = search_text_rows(db, "alpha", &[1.0, 0.0, 0.5], 5)
                .await
                .expect("search rows");
            (row_count, search_rows)
        });

        assert_eq!(row_count, 130);
        assert!(!search_rows.is_empty());
        assert!(search_rows
            .iter()
            .any(|row| row.display_name == "source" && row.text.contains("alpha chunk")));
    }

    #[test]
    fn write_image_embeddings_batches_rows() {
        let runtime = Runtime::new().expect("tokio runtime");
        let knowledge_root = temp_test_dir("knowledge-image-batches");
        let manager = KnowledgeManager::new();
        manager
            .set_root_dir(knowledge_root)
            .expect("knowledge root");
        let source = test_source(
            KnowledgeModality::Image,
            Some("/tmp/source.png".to_string()),
        );
        let embeddings = (0..130)
            .map(|index| make_image_embed(vec![0.5, index as f32, 1.0]))
            .collect::<Vec<_>>();

        let written_rows = runtime
            .block_on(write_image_embeddings(&manager, &source, embeddings))
            .expect("image rows");
        assert_eq!(written_rows, 130);

        let (row_count, search_rows) = runtime.block_on(async {
            let runtime_guard = manager.runtime.lock().await;
            let db = runtime_guard.db.as_ref().expect("db loaded");
            let row_count = count_rows_if_exists(db, IMAGE_TABLE)
                .await
                .expect("row count");
            let search_rows = search_image_rows(db, &[0.5, 0.0, 1.0], 2)
                .await
                .expect("search rows");
            (row_count, search_rows)
        });

        assert_eq!(row_count, 130);
        assert!(!search_rows.is_empty());
        assert!(search_rows.iter().any(|row| row.display_name == "source"
            && row.asset_path.as_deref() == Some("/tmp/source.png")));
    }

    #[test]
    fn runtime_unloads_after_idle_and_db_use_reloads_it() {
        let runtime = Runtime::new().expect("tokio runtime");
        let knowledge_root = temp_test_dir("knowledge-runtime-idle");
        let manager = KnowledgeManager::new();
        manager
            .set_root_dir(knowledge_root)
            .expect("knowledge root");

        runtime.block_on(async {
            manager
                .ensure_runtime_components(None, false, false)
                .await
                .expect("load db only");
            {
                let runtime_guard = manager.runtime.lock().await;
                assert!(runtime_guard.db.is_some());
            }

            *manager.activity.last_activity.lock().unwrap() =
                Instant::now() - KNOWLEDGE_RUNTIME_IDLE_TIMEOUT;
            manager.activity.active_uses.store(0, Ordering::SeqCst);

            assert!(
                unload_runtime_if_idle(&manager.runtime, &manager.activity, Instant::now()).await
            );
            {
                let runtime_guard = manager.runtime.lock().await;
                assert!(runtime_guard.db.is_none());
            }

            manager
                .ensure_runtime_components(None, false, false)
                .await
                .expect("reload db only");
            let runtime_guard = manager.runtime.lock().await;
            assert!(runtime_guard.db.is_some());
        });
    }

    #[test]
    #[ignore = "manual end-to-end test that downloads Knowledge models and exercises LanceDB"]
    fn manual_e2e_knowledge_lifecycle() {
        let temp_root =
            std::env::temp_dir().join(format!("friday-knowledge-e2e-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_root).expect("temp root");

        let db_path = temp_root.join("friday.db");
        storage::init_db(&db_path).expect("db init");

        let knowledge_root = temp_root.join("rag");
        let manager = KnowledgeManager::new();
        manager
            .set_root_dir(knowledge_root.clone())
            .expect("knowledge root");

        let doc_path = temp_root.join("notes.md");
        std::fs::write(
            &doc_path,
            "Friday stores knowledge locally.\nKnowledge retrieval can ground replies against indexed files.",
        )
        .expect("fixture file");

        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");

        let ingest = runtime
            .block_on(ingest_file(
                &manager,
                &db_path,
                None,
                doc_path.to_str().expect("fixture path"),
            ))
            .expect("knowledge ingest");

        assert_eq!(ingest.status, "indexed");
        assert!(ingest.chunk_count > 0);

        let results = runtime
            .block_on(search(
                &manager,
                &db_path,
                "How does Friday use local knowledge for grounded replies?",
            ))
            .expect("knowledge search");

        assert!(!results.citations.is_empty());
        assert!(results
            .text_snippets
            .iter()
            .any(|snippet| snippet.snippet.to_lowercase().contains("knowledge")));

        let conn = rusqlite::Connection::open(&db_path).expect("reopen db");
        let sources = list_sources(&conn).expect("source list");
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].display_name, "notes.md");

        let stats_before_delete = runtime
            .block_on(stats(&manager, &db_path))
            .expect("knowledge stats");
        assert_eq!(stats_before_delete.total_sources, 1);
        assert!(stats_before_delete.total_text_chunks > 0);

        let delete_result = runtime
            .block_on(delete_source(&manager, &db_path, &sources[0].id))
            .expect("delete source");
        assert!(delete_result.deleted);

        let conn = rusqlite::Connection::open(&db_path).expect("reopen db after delete");
        let remaining_sources = list_sources(&conn).expect("remaining sources");
        assert!(remaining_sources.is_empty());

        let stats_after_delete = runtime
            .block_on(stats(&manager, &db_path))
            .expect("knowledge stats after delete");
        assert_eq!(stats_after_delete.total_sources, 0);
        assert_eq!(stats_after_delete.total_text_chunks, 0);
        assert_eq!(stats_after_delete.total_image_assets, 0);

        let _ = std::fs::remove_dir_all(&temp_root);
    }
}
