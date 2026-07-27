-- Preserve the observability origin when a trace/observation becomes a dataset item.
ALTER TABLE dataset_items
    ADD COLUMN IF NOT EXISTS source_trace_id TEXT,
    ADD COLUMN IF NOT EXISTS source_observation_id TEXT;

CREATE INDEX IF NOT EXISTS dataset_items_source_trace_idx
    ON dataset_items(source_trace_id)
    WHERE source_trace_id IS NOT NULL;
