-- Existing installations require the migration runner's explicit maintenance
-- acknowledgement after ALL old writers and in-flight inserts have been drained.
-- Zero is only a legacy sentinel, never a valid default for a live writer.
ALTER TABLE logs
    ADD COLUMN IF NOT EXISTS physical_row_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
    ADD CONSTRAINT IF NOT EXISTS logs_physical_row_id_v4 CHECK match(toString(physical_row_id), '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

-- The runner first waits for unfinished log mutations, then reads this probe.
-- Completed work must not enqueue another rewrite after a lost acknowledgement.
SELECT EXISTS(SELECT 1 FROM logs WHERE physical_row_id = toUUID('00000000-0000-0000-0000-000000000000')) OR EXISTS(SELECT 1 FROM system.parts WHERE database = currentDatabase() AND table = 'logs' AND active AND rows > 0 AND name NOT IN (SELECT name FROM system.parts_columns WHERE database = currentDatabase() AND table = 'logs' AND active AND column = 'physical_row_id' AND ((part_type = 'Wide' AND column_bytes_on_disk > 0) OR (part_type = 'Compact' AND data_compressed_bytes > 0 AND marks_bytes > 0)))) AS needs_backfill;

-- Submit only when the probe requires it, and poll to completion in the runner.
-- Rewrite every part to store the column, assigning ONLY zero-sentinel IDs.
-- MATERIALIZE of a random DEFAULT can reassign IDs after partial replay.
ALTER TABLE logs UPDATE physical_row_id = if(physical_row_id = toUUID('00000000-0000-0000-0000-000000000000'), generateUUIDv4(), physical_row_id) WHERE 1 SETTINGS mutations_sync = 0;

SELECT throwIf(countIf(NOT match(toString(physical_row_id), '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) > 0 OR count() != uniqExact(tuple(organization_id, project_id, physical_row_id)), 'Physical log UUID backfill is incomplete or contains duplicated scoped IDs') FROM logs;

SELECT throwIf(count() > 0, 'Physical log UUID column is not stored in every populated active part') FROM system.parts WHERE database = currentDatabase() AND table = 'logs' AND active AND rows > 0 AND name NOT IN (SELECT name FROM system.parts_columns WHERE database = currentDatabase() AND table = 'logs' AND active AND column = 'physical_row_id' AND ((part_type = 'Wide' AND column_bytes_on_disk > 0) OR (part_type = 'Compact' AND data_compressed_bytes > 0 AND marks_bytes > 0)));
