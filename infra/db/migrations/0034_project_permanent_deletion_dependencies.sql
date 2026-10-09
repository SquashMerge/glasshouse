-- A permanent project deletion removes project content and work, while immutable
-- audit facts retain their tenant and project UUID provenance.
ALTER TABLE governance_audit_events
    DISABLE TRIGGER governance_audit_events_immutable;
ALTER TABLE governance_audit_events
    ALTER COLUMN policy_version_id DROP NOT NULL;
ALTER TABLE governance_audit_events
    DROP CONSTRAINT IF EXISTS governance_audit_events_version_tenant_fkey;
ALTER TABLE governance_audit_events
    ADD CONSTRAINT governance_audit_events_policy_version_fkey
    FOREIGN KEY (policy_version_id)
    REFERENCES governance_policy_versions(id)
    ON DELETE SET NULL;
ALTER TABLE governance_audit_events
    ENABLE TRIGGER governance_audit_events_immutable;

CREATE OR REPLACE FUNCTION project_deletion_is_authorized(target_project_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT current_setting('glasshouse.project_deletion_id', true) = target_project_id::text
$$;

CREATE OR REPLACE FUNCTION prevent_prompt_tombstone_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'prompt tombstones are immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION prevent_prompt_deletion_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'prompt deletion audit rows are immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION prevent_human_feedback_score_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
        RETURN OLD;
    END IF;
    IF OLD.name = 'human.feedback' THEN
        RAISE EXCEPTION 'human.feedback scores are immutable';
    END IF;
    RETURN OLD;
END
$$;

CREATE OR REPLACE FUNCTION prevent_prompt_optimization_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND EXISTS (
        SELECT 1
        FROM prompt_optimization_jobs
        WHERE id = OLD.job_id
          AND project_deletion_is_authorized(project_id)
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'prompt optimization events are immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION prevent_governance_immutable_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
        RETURN OLD;
    END IF;
    IF TG_TABLE_NAME = 'governance_audit_events'
        AND TG_OP = 'UPDATE'
        AND project_deletion_is_authorized(OLD.project_id)
        AND NEW.project_id = OLD.project_id
        AND NEW.policy_version_id IS NULL
        AND NEW.organization_id = OLD.organization_id
        AND NEW.actor_subject = OLD.actor_subject
        AND NEW.event_type = OLD.event_type
        AND NEW.counts = OLD.counts
        AND NEW.duration_ms IS NOT DISTINCT FROM OLD.duration_ms
        AND NEW.created_at = OLD.created_at THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'governance records are immutable';
END
$$;

CREATE OR REPLACE FUNCTION prevent_project_authorization_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'project authorization audit events are append-only'
        USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION prevent_final_workspace_role_removal() RETURNS trigger AS $$
BEGIN
    IF TG_TABLE_NAME = 'organization_memberships' THEN
        PERFORM 1 FROM organizations WHERE id = OLD.organization_id FOR UPDATE;
        IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
            RAISE EXCEPTION 'organization membership scope is immutable';
        END IF;
        IF OLD.role = 'owner'
            AND (TG_OP = 'DELETE' OR NEW.role <> OLD.role)
            AND NOT EXISTS (
                SELECT 1 FROM organization_memberships
                WHERE organization_id = OLD.organization_id
                    AND actor_subject <> OLD.actor_subject
                    AND role = 'owner'
            ) THEN
            RAISE EXCEPTION 'cannot remove or demote the final organization owner';
        END IF;
    END IF;

    IF TG_TABLE_NAME = 'project_memberships' THEN
        IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
            RETURN OLD;
        END IF;
        PERFORM 1 FROM projects WHERE id = OLD.project_id FOR UPDATE;
        IF TG_OP = 'UPDATE' AND (
            NEW.project_id IS DISTINCT FROM OLD.project_id
            OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        ) THEN
            RAISE EXCEPTION 'project membership scope is immutable';
        END IF;
        IF OLD.role = 'manager'
            AND (TG_OP = 'DELETE' OR NEW.role <> OLD.role)
            AND EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND status = 'active')
            AND NOT EXISTS (
                SELECT 1 FROM project_memberships
                WHERE project_id = OLD.project_id
                    AND actor_subject <> OLD.actor_subject
                    AND role = 'manager'
            ) THEN
            RAISE EXCEPTION 'cannot remove or demote the final active project manager';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
