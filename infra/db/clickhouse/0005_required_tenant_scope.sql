-- Trace data with no verified tenant provenance cannot be safely reassigned.
-- Purge it before enforcing the invariant for every future insert.
ALTER TABLE traces
    DELETE WHERE organization_id = '' OR project_id = ''
    SETTINGS mutations_sync = 2;

ALTER TABLE observations
    DELETE WHERE organization_id = '' OR project_id = ''
    SETTINGS mutations_sync = 2;

ALTER TABLE traces
    ADD CONSTRAINT IF NOT EXISTS traces_tenant_scope_required
    CHECK notEmpty(organization_id) AND notEmpty(project_id);

ALTER TABLE observations
    ADD CONSTRAINT IF NOT EXISTS observations_tenant_scope_required
    CHECK notEmpty(organization_id) AND notEmpty(project_id);
