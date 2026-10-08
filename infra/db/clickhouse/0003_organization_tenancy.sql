-- Glasshouse ClickHouse schema: organization tenancy
-- Existing rows retain an empty organization_id because their historical
-- tenant cannot be determined safely. Tenant-scoped queries exclude them.

ALTER TABLE traces
    ADD COLUMN IF NOT EXISTS organization_id String AFTER trace_id;

ALTER TABLE observations
    ADD COLUMN IF NOT EXISTS organization_id String AFTER trace_id;
