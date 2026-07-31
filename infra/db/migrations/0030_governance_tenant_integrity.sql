-- Governance records retain both tenant keys so every policy artifact can be
-- independently checked against the project that owns it.
ALTER TABLE governance_policies
    DROP CONSTRAINT IF EXISTS governance_policies_project_id_fkey;
ALTER TABLE governance_policies
    ADD CONSTRAINT governance_policies_project_organization_fkey
    FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id)
    ON DELETE CASCADE;

ALTER TABLE governance_policy_versions
    ADD CONSTRAINT governance_policy_versions_project_organization_fkey
    FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id)
    ON DELETE CASCADE;
ALTER TABLE governance_policy_versions
    ADD CONSTRAINT governance_policy_versions_id_project_organization_key
    UNIQUE (id, organization_id, project_id);

ALTER TABLE governance_policy_approvals
    DROP CONSTRAINT IF EXISTS governance_policy_approvals_policy_version_id_fkey;
ALTER TABLE governance_policy_approvals
    DROP CONSTRAINT IF EXISTS governance_policy_approvals_project_id_fkey;
ALTER TABLE governance_policy_approvals
    ADD CONSTRAINT governance_policy_approvals_version_tenant_fkey
    FOREIGN KEY (policy_version_id, organization_id, project_id)
    REFERENCES governance_policy_versions(id, organization_id, project_id)
    ON DELETE RESTRICT;

ALTER TABLE governance_audit_events
    DROP CONSTRAINT IF EXISTS governance_audit_events_policy_version_id_fkey;
ALTER TABLE governance_audit_events
    DROP CONSTRAINT IF EXISTS governance_audit_events_project_id_fkey;
ALTER TABLE governance_audit_events
    ADD CONSTRAINT governance_audit_events_version_tenant_fkey
    FOREIGN KEY (policy_version_id, organization_id, project_id)
    REFERENCES governance_policy_versions(id, organization_id, project_id)
    ON DELETE RESTRICT;

ALTER TABLE governance_retention_runs
    DROP CONSTRAINT IF EXISTS governance_retention_runs_policy_version_id_fkey;
ALTER TABLE governance_retention_runs
    DROP CONSTRAINT IF EXISTS governance_retention_runs_project_id_fkey;
ALTER TABLE governance_retention_runs
    ADD CONSTRAINT governance_retention_runs_version_tenant_fkey
    FOREIGN KEY (policy_version_id, organization_id, project_id)
    REFERENCES governance_policy_versions(id, organization_id, project_id)
    ON DELETE RESTRICT;
