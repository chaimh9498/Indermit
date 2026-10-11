ALTER TABLE generations ADD COLUMN source_generation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_generations_source ON generations(source_generation_id);
