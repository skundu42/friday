ALTER TABLE audit_log ADD COLUMN request_id TEXT;
ALTER TABLE audit_log ADD COLUMN failure_stage TEXT;
ALTER TABLE audit_log ADD COLUMN attachment_count INTEGER DEFAULT 0;
ALTER TABLE audit_log ADD COLUMN cancelled INTEGER DEFAULT 0;
ALTER TABLE audit_log ADD COLUMN web_assist_enabled INTEGER DEFAULT 0;
ALTER TABLE audit_log ADD COLUMN knowledge_enabled INTEGER DEFAULT 0;
ALTER TABLE audit_log ADD COLUMN thinking_enabled INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_log(request_id);
