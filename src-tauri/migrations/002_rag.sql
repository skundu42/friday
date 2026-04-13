-- RAG documents table
CREATE TABLE IF NOT EXISTS rag_documents (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    ingested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- RAG chunks table (metadata only — vectors stored in ChromaDB)
CREATE TABLE IF NOT EXISTS rag_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    metadata TEXT
);

-- Settings for RAG
-- Stored via existing settings table with key 'rag_settings'

CREATE INDEX IF NOT EXISTS idx_rag_chunks_document ON rag_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_rag_documents_path ON rag_documents(file_path);
