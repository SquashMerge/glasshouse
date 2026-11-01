-- Content-free audit facts for representative user mutations. Resource IDs and
-- version numbers are provenance, not prompt, feedback, or telemetry payloads.
CREATE TABLE IF NOT EXISTS user_action_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK (action IN (
        'prompt_created',
        'prompt_version_created',
        'feedback_created'
    )),
    prompt_id UUID,
    prompt_version INTEGER,
    feedback_score_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (action = 'prompt_created'
            AND prompt_id IS NOT NULL
            AND prompt_version = 1
            AND feedback_score_id IS NULL)
        OR (action = 'prompt_version_created'
            AND prompt_id IS NOT NULL
            AND prompt_version > 1
            AND feedback_score_id IS NULL)
        OR (action = 'feedback_created'
            AND prompt_id IS NULL
            AND prompt_version IS NULL
            AND feedback_score_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS user_action_audit_events_prompt_scope_key
    ON user_action_audit_events (project_id, prompt_id, prompt_version, action)
    WHERE prompt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_action_audit_events_feedback_scope_key
    ON user_action_audit_events (project_id, feedback_score_id)
    WHERE feedback_score_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_action_audit_events_organization_created_idx
    ON user_action_audit_events (organization_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION enforce_user_action_audit_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1 FROM projects WHERE id = NEW.project_id FOR KEY SHARE;
    PERFORM lock_project_audit_provenance(NEW.project_id);

    IF NOT EXISTS (
        SELECT 1 FROM projects
        WHERE id = NEW.project_id AND organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'user action audit project belongs to another organization'
            USING ERRCODE = '23503';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM actor_identities
        WHERE organization_id = NEW.organization_id AND actor_id = NEW.actor_id
    ) THEN
        RAISE EXCEPTION 'user action audit actor is outside the organization'
            USING ERRCODE = '23503';
    END IF;

    IF NEW.prompt_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM prompts AS prompt
        JOIN prompt_versions AS version ON version.prompt_id = prompt.id
        WHERE prompt.id = NEW.prompt_id
          AND prompt.project_id = NEW.project_id
          AND version.version = NEW.prompt_version
    ) THEN
        RAISE EXCEPTION 'user action audit prompt scope is invalid'
            USING ERRCODE = '23503';
    END IF;

    IF NEW.feedback_score_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM scores
        WHERE id = NEW.feedback_score_id
          AND project_id = NEW.project_id
          AND name = 'human.feedback'
          AND feedback_actor_id = NEW.actor_id
    ) THEN
        RAISE EXCEPTION 'user action audit feedback scope is invalid'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_user_action_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'user action audit events are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS user_action_audit_events_00_provenance ON user_action_audit_events;
CREATE TRIGGER user_action_audit_events_00_provenance
BEFORE INSERT ON user_action_audit_events
FOR EACH ROW EXECUTE FUNCTION enforce_user_action_audit_scope();

DROP TRIGGER IF EXISTS user_action_audit_events_immutable ON user_action_audit_events;
CREATE TRIGGER user_action_audit_events_immutable
BEFORE UPDATE OR DELETE ON user_action_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_user_action_audit_mutation();

CREATE OR REPLACE FUNCTION prevent_project_audit_uuid_reuse()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM lock_project_audit_provenance(NEW.id);

    IF EXISTS (
        SELECT 1 FROM project_authorization_audit_events WHERE project_id = NEW.id
        UNION ALL SELECT 1 FROM project_lifecycle_audit_events WHERE project_id = NEW.id
        UNION ALL SELECT 1 FROM governance_audit_events WHERE project_id = NEW.id
        UNION ALL SELECT 1 FROM admin_access_audit_events WHERE project_id = NEW.id
        UNION ALL SELECT 1 FROM evaluation_gate_audit_events WHERE project_id = NEW.id
        UNION ALL SELECT 1 FROM user_action_audit_events WHERE project_id = NEW.id
    ) THEN
        RAISE EXCEPTION 'project UUID has retained audit provenance' USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END;
$$;
