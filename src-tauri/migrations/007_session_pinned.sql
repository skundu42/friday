ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sessions_pinned_updated
    ON sessions(pinned DESC, updated_at DESC);
