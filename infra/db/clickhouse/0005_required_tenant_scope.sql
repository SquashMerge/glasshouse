-- Constraints do not validate historical rows, so install them before cleanup to
-- prevent concurrent writers from creating more unscoped data during the mutation.
ALTER TABLE traces
    ADD CONSTRAINT IF NOT EXISTS traces_tenant_scope_required
    CHECK notEmpty(organization_id) AND notEmpty(project_id);

ALTER TABLE observations
    ADD CONSTRAINT IF NOT EXISTS observations_tenant_scope_required
    CHECK notEmpty(organization_id) AND notEmpty(project_id);

-- Historical unscoped rows cannot be safely attributed to a tenant.
ALTER TABLE traces
    DELETE WHERE organization_id = '' OR project_id = ''
    SETTINGS mutations_sync = 2;

ALTER TABLE observations
    DELETE WHERE organization_id = '' OR project_id = ''
    SETTINGS mutations_sync = 2;
