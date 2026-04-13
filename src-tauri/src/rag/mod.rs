#![allow(dead_code)]

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashSet;
use std::io::{Cursor, Read};
use std::path::Path;
use uuid::Uuid;

const CHUNK_SIZE_CHARS: usize = 1200;
const CHUNK_OVERLAP_CHARS: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestionRequest {
    pub file_path: String,
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestFolderRequest {
    pub folder_path: String,
    pub recursive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub text: String,
    pub source_file: String,
    pub file_name: String,
    pub chunk_index: usize,
    pub doc_id: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestResult {
    pub doc_id: Option<String>,
    pub file_name: Option<String>,
    pub chunks: Option<usize>,
    pub ingested: Option<usize>,
    pub errors: Option<usize>,
    pub status: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentInfo {
    pub doc_id: String,
    pub file_name: String,
    pub source_file: String,
    pub total_chunks: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentListResponse {
    pub documents: Vec<DocumentInfo>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagStats {
    pub total_chunks: usize,
    pub storage_dir: String,
}

pub fn ingest_file(conn: &Connection, file_path: &str) -> Result<IngestResult, String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    if !path.is_file() {
        return Err(format!("Not a file: {}", file_path));
    }

    let extracted = extract_file_text(path)?;
    let normalized = normalize_text(&extracted.text);
    if normalized.is_empty() {
        return Ok(IngestResult {
            doc_id: None,
            file_name: Some(extracted.file_name),
            chunks: Some(0),
            ingested: Some(0),
            errors: Some(1),
            status: Some("empty".to_string()),
            error: Some("No searchable text could be extracted from this file.".to_string()),
        });
    }

    let chunks = chunk_text(&normalized);
    let doc_id = Uuid::new_v4().to_string();

    conn.execute(
        "INSERT INTO rag_documents (id, file_path, file_name, file_type, file_size_bytes, chunk_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            doc_id,
            extracted.source_file,
            extracted.file_name,
            extracted.file_type,
            extracted.file_size_bytes as i64,
            chunks.len() as i64,
        ],
    )
    .map_err(|e| format!("Failed to insert RAG document: {}", e))?;

    for (index, chunk) in chunks.iter().enumerate() {
        let chunk_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO rag_chunks (id, document_id, chunk_index, text, char_count, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                chunk_id,
                doc_id,
                index as i64,
                chunk,
                chunk.chars().count() as i64,
                serde_json::json!({"source":"rust-rag"}).to_string(),
            ],
        )
        .map_err(|e| format!("Failed to insert RAG chunk: {}", e))?;
    }

    Ok(IngestResult {
        doc_id: Some(doc_id),
        file_name: Some(extracted.file_name),
        chunks: Some(chunks.len()),
        ingested: Some(1),
        errors: Some(0),
        status: Some("ok".to_string()),
        error: None,
    })
}

pub fn ingest_folder(
    conn: &Connection,
    folder_path: &str,
    recursive: bool,
) -> Result<IngestResult, String> {
    let path = Path::new(folder_path);
    if !path.exists() {
        return Err(format!("Folder not found: {}", folder_path));
    }
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", folder_path));
    }

    let mut ingested = 0usize;
    let mut errors = 0usize;
    let mut total_chunks = 0usize;
    let mut stack = vec![path.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read directory {}: {}", dir.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let entry_path = entry.path();
            if entry_path.is_dir() {
                if recursive {
                    stack.push(entry_path);
                }
                continue;
            }

            match ingest_file(conn, &entry_path.to_string_lossy()) {
                Ok(result) => {
                    ingested += usize::from(result.doc_id.is_some());
                    total_chunks += result.chunks.unwrap_or(0);
                    errors += result.errors.unwrap_or(0);
                }
                Err(_) => {
                    errors += 1;
                }
            }
        }
    }

    Ok(IngestResult {
        doc_id: None,
        file_name: None,
        chunks: Some(total_chunks),
        ingested: Some(ingested),
        errors: Some(errors),
        status: Some("ok".to_string()),
        error: None,
    })
}

pub fn search(conn: &Connection, query: &str, top_k: usize) -> Result<SearchResponse, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(SearchResponse {
            results: Vec::new(),
            total: 0,
        });
    }

    let mut stmt = conn
        .prepare(
            "SELECT c.text, d.file_path, d.file_name, c.chunk_index, d.id
             FROM rag_chunks c
             JOIN rag_documents d ON d.id = c.document_id",
        )
        .map_err(|e| format!("Failed to prepare RAG search: {}", e))?;

    let mut rows = stmt
        .query([])
        .map_err(|e| format!("Failed to query RAG chunks: {}", e))?;

    let mut scored = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("Failed to iterate RAG chunks: {}", e))?
    {
        let text: String = row.get(0).map_err(|e| e.to_string())?;
        let score = score_chunk(trimmed, &text);
        if score <= 0.0 {
            continue;
        }

        scored.push(SearchResult {
            text,
            source_file: row.get(1).map_err(|e| e.to_string())?,
            file_name: row.get(2).map_err(|e| e.to_string())?,
            chunk_index: row.get::<_, i64>(3).map_err(|e| e.to_string())? as usize,
            doc_id: row.get(4).map_err(|e| e.to_string())?,
            score,
        });
    }

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
    scored.truncate(top_k.max(1));

    Ok(SearchResponse {
        total: scored.len(),
        results: scored,
    })
}

pub fn list_documents(conn: &Connection) -> Result<DocumentListResponse, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, file_name, file_path, chunk_count
             FROM rag_documents
             ORDER BY ingested_at DESC",
        )
        .map_err(|e| format!("Failed to prepare RAG document list: {}", e))?;

    let documents = stmt
        .query_map([], |row| {
            Ok(DocumentInfo {
                doc_id: row.get(0)?,
                file_name: row.get(1)?,
                source_file: row.get(2)?,
                total_chunks: row.get::<_, i64>(3)? as usize,
            })
        })
        .map_err(|e| format!("Failed to list RAG documents: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to decode RAG document list: {}", e))?;

    Ok(DocumentListResponse {
        total: documents.len(),
        documents,
    })
}

pub fn delete_document(conn: &Connection, doc_id: &str) -> Result<IngestResult, String> {
    conn.execute("DELETE FROM rag_documents WHERE id = ?1", params![doc_id])
        .map_err(|e| format!("Failed to delete RAG document: {}", e))?;

    Ok(IngestResult {
        doc_id: Some(doc_id.to_string()),
        file_name: None,
        chunks: None,
        ingested: Some(0),
        errors: Some(0),
        status: Some("deleted".to_string()),
        error: None,
    })
}

pub fn stats(conn: &Connection, storage_dir: &Path) -> Result<RagStats, String> {
    let total_chunks: i64 = conn
        .query_row("SELECT COUNT(*) FROM rag_chunks", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count RAG chunks: {}", e))?;

    Ok(RagStats {
        total_chunks: total_chunks as usize,
        storage_dir: storage_dir.display().to_string(),
    })
}

struct ExtractedFile {
    text: String,
    source_file: String,
    file_name: String,
    file_type: String,
    file_size_bytes: u64,
}

fn normalized_file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn is_text_ingestible_file(extension: &str, normalized_name: &str) -> bool {
    matches!(
        extension,
        "txt"
            | "md"
            | "markdown"
            | "csv"
            | "json"
            | "xml"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "cfg"
            | "conf"
            | "log"
            | "rs"
            | "py"
            | "js"
            | "ts"
            | "tsx"
            | "jsx"
            | "html"
            | "css"
            | "scss"
            | "sql"
            | "sh"
            | "bash"
            | "zsh"
            | "go"
            | "java"
            | "c"
            | "cpp"
            | "h"
            | "hpp"
            | "rb"
            | "php"
            | "swift"
            | "kt"
            | "dart"
            | "lua"
            | "r"
            | "m"
            | "tex"
            | "bib"
            | "env"
    ) || matches!(
        normalized_name,
        ".env" | ".gitignore" | "dockerfile" | "makefile"
    )
}

fn extract_file_text(path: &Path) -> Result<ExtractedFile, String> {
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Cannot read file metadata: {}", e))?;
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let normalized_name = normalized_file_name(path);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let text = match extension.as_str() {
        extension if is_text_ingestible_file(extension, &normalized_name) => {
            std::fs::read_to_string(path).map_err(|e| format!("Cannot read file: {}", e))?
        }
        "pdf" => {
            let bytes = std::fs::read(path).map_err(|e| format!("Cannot read PDF: {}", e))?;
            extract_pdf_text(&bytes)
        }
        "docx" => {
            let bytes = std::fs::read(path).map_err(|e| format!("Cannot read DOCX: {}", e))?;
            extract_docx_text(&bytes)
        }
        _ => {
            return Err(format!(
                "File type .{} is not supported for RAG ingestion.",
                extension
            ))
        }
    };

    Ok(ExtractedFile {
        text,
        source_file: path.display().to_string(),
        file_name,
        file_type: if extension.is_empty() {
            normalized_name
        } else {
            extension
        },
        file_size_bytes: metadata.len(),
    })
}

fn chunk_text(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + CHUNK_SIZE_CHARS).min(chars.len());
        let chunk: String = chars[start..end].iter().collect();
        let normalized = normalize_text(&chunk);
        if !normalized.is_empty() {
            chunks.push(normalized);
        }

        if end == chars.len() {
            break;
        }
        start = end.saturating_sub(CHUNK_OVERLAP_CHARS);
    }

    chunks
}

fn score_chunk(query: &str, text: &str) -> f64 {
    let query_tokens = tokenize(query);
    if query_tokens.is_empty() {
        return 0.0;
    }

    let text_lower = text.to_lowercase();
    let mut score = 0.0;
    let text_tokens = tokenize(text);
    let token_set: HashSet<&str> = text_tokens.iter().map(String::as_str).collect();

    for token in &query_tokens {
        if token_set.contains(token.as_str()) {
            score += 1.0;
        } else if text_lower.contains(token) {
            score += 0.5;
        }
    }

    score / query_tokens.len() as f64
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|part| part.len() >= 2)
        .map(ToString::to_string)
        .collect()
}

fn normalize_text(text: &str) -> String {
    text.replace('\u{00A0}', " ")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_pdf_text(bytes: &[u8]) -> String {
    match pdf_extract::extract_text_from_mem(bytes) {
        Ok(text) => {
            let normalized = normalize_text(&text);
            if normalized.is_empty() {
                "[Could not extract text from PDF. The file may be scanned/image-based.]"
                    .to_string()
            } else {
                normalized
            }
        }
        Err(_) => {
            "[Could not extract text from PDF. The file may be scanned/image-based.]".to_string()
        }
    }
}

fn extract_docx_text(bytes: &[u8]) -> String {
    let cursor = Cursor::new(bytes);
    let mut archive = match zip::ZipArchive::new(cursor) {
        Ok(archive) => archive,
        Err(_) => return "[Could not extract text from DOCX.]".to_string(),
    };

    let mut document_xml = String::new();
    let mut document = match archive.by_name("word/document.xml") {
        Ok(file) => file,
        Err(_) => return "[Could not extract text from DOCX.]".to_string(),
    };

    if document.read_to_string(&mut document_xml).is_err() {
        return "[Could not extract text from DOCX.]".to_string();
    }

    let mut text = document_xml
        .replace("</w:p>", "\n")
        .replace("</w:tr>", "\n")
        .replace("</w:tc>", "\t")
        .replace("<w:tab/>", "\t")
        .replace("<w:br/>", "\n")
        .replace("<w:cr/>", "\n");

    while let Some(start) = text.find('<') {
        let Some(end) = text[start..].find('>') else {
            break;
        };
        text.replace_range(start..start + end + 1, "");
    }

    let decoded = decode_xml_entities(&text);
    let normalized = normalize_text(&decoded);
    if normalized.is_empty() {
        "[Could not extract text from DOCX.]".to_string()
    } else {
        normalized
    }
}

fn decode_xml_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_text_overlaps_and_preserves_order() {
        let text = "a".repeat(CHUNK_SIZE_CHARS + 100);
        let chunks = chunk_text(&text);

        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].len() >= CHUNK_SIZE_CHARS.saturating_sub(1));
        assert!(chunks[1].len() >= 100);
    }

    #[test]
    fn search_scores_matching_chunks() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/002_rag.sql"))
            .unwrap();
        conn.execute_batch(include_str!("../../migrations/001_initial.sql"))
            .unwrap();
        conn.execute(
            "INSERT INTO rag_documents (id, file_path, file_name, file_type, file_size_bytes, chunk_count)
             VALUES ('doc-1', '/tmp/a.md', 'a.md', 'md', 10, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO rag_chunks (id, document_id, chunk_index, text, char_count, metadata)
             VALUES ('chunk-1', 'doc-1', 0, 'Friday uses local inference with LiteRT', 38, '{}')",
            [],
        )
        .unwrap();

        let response = search(&conn, "local litert", 5).unwrap();
        assert_eq!(response.total, 1);
        assert!(response.results[0].score > 0.0);
    }

    #[test]
    fn extract_file_text_supports_special_text_filenames() {
        let temp_dir = std::env::temp_dir().join(format!("friday-rag-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();

        for (name, expected_type) in [
            (".gitignore", ".gitignore"),
            ("Dockerfile", "dockerfile"),
            ("Makefile", "makefile"),
        ] {
            let path = temp_dir.join(name);
            std::fs::write(&path, "node_modules/\n").unwrap();

            let extracted = extract_file_text(&path).unwrap();
            assert_eq!(extracted.text, "node_modules/\n");
            assert_eq!(extracted.file_type, expected_type);
        }

        std::fs::remove_dir_all(&temp_dir).unwrap();
    }
}
