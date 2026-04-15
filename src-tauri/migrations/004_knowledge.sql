CREATE TABLE IF NOT EXISTS knowledge_sources (
    id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL,
    modality TEXT NOT NULL,
    locator TEXT NOT NULL,
    display_name TEXT NOT NULL,
    mime_type TEXT,
    file_size_bytes INTEGER,
    asset_path TEXT,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    error TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_sources_locator_hash
    ON knowledge_sources(locator, content_hash);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_status
    ON knowledge_sources(status);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_modality
    ON knowledge_sources(modality);

DROP TABLE IF EXISTS rag_chunks;
DROP TABLE IF EXISTS rag_documents;
