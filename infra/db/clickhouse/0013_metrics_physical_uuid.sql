-- Existing installations must drain ALL old metric writers and in-flight inserts
-- before acknowledging this migration. Zero is only a legacy sentinel.
ALTER TABLE metrics
    ADD COLUMN IF NOT EXISTS physical_row_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
    ADD CONSTRAINT IF NOT EXISTS metrics_physical_row_id_v4 CHECK match(toString(physical_row_id), '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

SELECT EXISTS(SELECT 1 FROM metrics WHERE physical_row_id = toUUID('00000000-0000-0000-0000-000000000000')) OR EXISTS(SELECT 1 FROM system.parts WHERE database = currentDatabase() AND table = 'metrics' AND active AND rows > 0 AND name NOT IN (SELECT name FROM system.parts_columns WHERE database = currentDatabase() AND table = 'metrics' AND active AND column = 'physical_row_id' AND ((part_type = 'Wide' AND column_bytes_on_disk > 0) OR (part_type = 'Compact' AND data_compressed_bytes > 0 AND marks_bytes > 0)))) AS needs_backfill;

ALTER TABLE metrics UPDATE physical_row_id = if(physical_row_id = toUUID('00000000-0000-0000-0000-000000000000'), generateUUIDv4(), physical_row_id) WHERE 1 SETTINGS mutations_sync = 0;

SELECT throwIf(countIf(NOT match(toString(physical_row_id), '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) > 0 OR count() != uniqExact(tuple(organization_id, project_id, physical_row_id)), 'Physical metric UUID backfill is incomplete or contains duplicated scoped IDs') FROM metrics;

SELECT throwIf(count() > 0, 'Physical metric UUID column is not stored in every populated active part') FROM system.parts WHERE database = currentDatabase() AND table = 'metrics' AND active AND rows > 0 AND name NOT IN (SELECT name FROM system.parts_columns WHERE database = currentDatabase() AND table = 'metrics' AND active AND column = 'physical_row_id' AND ((part_type = 'Wide' AND column_bytes_on_disk > 0) OR (part_type = 'Compact' AND data_compressed_bytes > 0 AND marks_bytes > 0)));
