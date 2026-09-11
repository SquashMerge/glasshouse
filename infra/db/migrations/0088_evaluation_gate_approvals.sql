-- P3.5: administrator-approved, immutable Evaluation Definition release gates.
-- Gate approvals and invocations are project-scoped; no gate follows mutable
-- latest state or carries protected Dataset item content into audit records.

CREATE TABLE IF NOT EXISTS evaluation_gate_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    evaluation_id UUID NOT NULL,
    definition_version_id UUID NOT NULL,
    dataset_version_id UUID NOT NULL,
    definition_content_hash TEXT NOT NULL CHECK (definition_content_hash ~ '^[0-9a-f]{64}$'),
    dataset_content_hash TEXT NOT NULL CHECK (dataset_content_hash ~ '^[0-9a-f]{64}$'),
    gate_context TEXT NOT NULL CHECK (gate_context IN ('ci', 'release')),
    minimum_pass_rate NUMERIC(6,5) NOT NULL CHECK (minimum_pass_rate >= 0 AND minimum_pass_rate <= 1),
    reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
    approved_by_actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    revoked_by_actor_id UUID REFERENCES actors(id) ON DELETE RESTRICT,
    revocation_reason TEXT CHECK (revocation_reason IS NULL OR length(btrim(revocation_reason)) BETWEEN 1 AND 1000),
    superseded_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (evaluation_id, project_id)
        REFERENCES evaluations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (definition_version_id, project_id)
        REFERENCES evaluation_definition_versions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, dataset_version_id)
        REFERENCES dataset_versions(project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (superseded_by, project_id)
        REFERENCES evaluation_gate_approvals(id, project_id) ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS evaluation_gate_approvals_active_scope_idx
    ON evaluation_gate_approvals (project_id, definition_version_id, gate_context)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS evaluation_gate_approvals_project_idx
    ON evaluation_gate_approvals (project_id, approved_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS evaluation_gate_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    approval_id UUID NOT NULL,
    evaluation_run_id UUID NOT NULL,
    evaluation_id UUID NOT NULL,
    definition_version_id UUID NOT NULL,
    dataset_version_id UUID NOT NULL,
    definition_content_hash TEXT NOT NULL CHECK (definition_content_hash ~ '^[0-9a-f]{64}$'),
    dataset_content_hash TEXT NOT NULL CHECK (dataset_content_hash ~ '^[0-9a-f]{64}$'),
    target_fingerprint TEXT NOT NULL CHECK (target_fingerprint ~ '^[0-9a-f]{64}$'),
    evaluator_fingerprint TEXT NOT NULL CHECK (evaluator_fingerprint ~ '^[0-9a-f]{64}$'),
    gate_context TEXT NOT NULL CHECK (gate_context IN ('ci', 'release')),
    minimum_pass_rate NUMERIC(6,5) NOT NULL CHECK (minimum_pass_rate >= 0 AND minimum_pass_rate <= 1),
    selected_count INTEGER CHECK (selected_count IS NULL OR selected_count >= 0),
    evaluated_count INTEGER CHECK (evaluated_count IS NULL OR evaluated_count >= 0),
    passed_count INTEGER CHECK (passed_count IS NULL OR passed_count >= 0),
    failed_count INTEGER CHECK (failed_count IS NULL OR failed_count >= 0),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'passed', 'failed', 'inconclusive', 'error', 'cancelled')),
    outcome_reason TEXT CHECK (outcome_reason IS NULL OR length(outcome_reason) <= 256),
    requested_by_actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, idempotency_key),
    UNIQUE (evaluation_run_id, project_id),
    UNIQUE (id, project_id),
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (approval_id, project_id)
        REFERENCES evaluation_gate_approvals(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (evaluation_run_id, project_id)
        REFERENCES evaluation_runs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (evaluation_id, project_id)
        REFERENCES evaluations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (definition_version_id, project_id)
        REFERENCES evaluation_definition_versions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, dataset_version_id)
        REFERENCES dataset_versions(project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS evaluation_gate_runs_project_status_idx
    ON evaluation_gate_runs (project_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS evaluation_gate_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    approval_id UUID,
    gate_run_id UUID,
    evaluation_run_id UUID,
    definition_version_id UUID,
    actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN ('approved', 'revoked', 'superseded', 'invoked', 'outcome_recorded')),
    gate_context TEXT CHECK (gate_context IS NULL OR gate_context IN ('ci', 'release')),
    outcome_status TEXT CHECK (outcome_status IS NULL OR outcome_status IN ('pending', 'passed', 'failed', 'inconclusive', 'error', 'cancelled')),
    reason_digest TEXT CHECK (reason_digest IS NULL OR reason_digest ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (approval_id, project_id)
        REFERENCES evaluation_gate_approvals(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (gate_run_id, project_id)
        REFERENCES evaluation_gate_runs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (evaluation_run_id, project_id)
        REFERENCES evaluation_runs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (definition_version_id, project_id)
        REFERENCES evaluation_definition_versions(id, project_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS evaluation_gate_audit_events_project_idx
    ON evaluation_gate_audit_events (project_id, created_at, id);

CREATE OR REPLACE FUNCTION prevent_evaluation_gate_approval_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN RETURN OLD; END IF;
    IF TG_OP = 'UPDATE' AND (
        NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
        NEW.project_id IS DISTINCT FROM OLD.project_id OR
        NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id OR
        NEW.definition_version_id IS DISTINCT FROM OLD.definition_version_id OR
        NEW.dataset_version_id IS DISTINCT FROM OLD.dataset_version_id OR
        NEW.definition_content_hash IS DISTINCT FROM OLD.definition_content_hash OR
        NEW.dataset_content_hash IS DISTINCT FROM OLD.dataset_content_hash OR
        NEW.gate_context IS DISTINCT FROM OLD.gate_context OR
        NEW.minimum_pass_rate IS DISTINCT FROM OLD.minimum_pass_rate OR
        NEW.reason IS DISTINCT FROM OLD.reason OR
        NEW.approved_by_actor_id IS DISTINCT FROM OLD.approved_by_actor_id OR
        NEW.approved_at IS DISTINCT FROM OLD.approved_at OR
        NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
        RAISE EXCEPTION 'Evaluation Gate approval contract is immutable' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.revoked_at IS NOT NULL AND (
        NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR
        NEW.revoked_by_actor_id IS DISTINCT FROM OLD.revoked_by_actor_id OR
        NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason OR
        NEW.superseded_by IS DISTINCT FROM OLD.superseded_by
    ) THEN
        RAISE EXCEPTION 'Evaluation Gate approval revocation is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS evaluation_gate_approvals_immutable ON evaluation_gate_approvals;
CREATE TRIGGER evaluation_gate_approvals_immutable
BEFORE UPDATE OR DELETE ON evaluation_gate_approvals
FOR EACH ROW EXECUTE FUNCTION prevent_evaluation_gate_approval_mutation();

CREATE OR REPLACE FUNCTION prevent_evaluation_gate_run_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN RETURN OLD; END IF;
    IF TG_OP = 'UPDATE' AND (
        NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
        NEW.project_id IS DISTINCT FROM OLD.project_id OR
        NEW.approval_id IS DISTINCT FROM OLD.approval_id OR
        NEW.evaluation_run_id IS DISTINCT FROM OLD.evaluation_run_id OR
        NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id OR
        NEW.definition_version_id IS DISTINCT FROM OLD.definition_version_id OR
        NEW.dataset_version_id IS DISTINCT FROM OLD.dataset_version_id OR
        NEW.definition_content_hash IS DISTINCT FROM OLD.definition_content_hash OR
        NEW.dataset_content_hash IS DISTINCT FROM OLD.dataset_content_hash OR
        NEW.target_fingerprint IS DISTINCT FROM OLD.target_fingerprint OR
        NEW.evaluator_fingerprint IS DISTINCT FROM OLD.evaluator_fingerprint OR
        NEW.gate_context IS DISTINCT FROM OLD.gate_context OR
        NEW.minimum_pass_rate IS DISTINCT FROM OLD.minimum_pass_rate OR
        NEW.requested_by_actor_id IS DISTINCT FROM OLD.requested_by_actor_id OR
        NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
        NEW.created_at IS DISTINCT FROM OLD.created_at
    ) THEN
        RAISE EXCEPTION 'Evaluation Gate Run contract is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS evaluation_gate_runs_immutable ON evaluation_gate_runs;
CREATE TRIGGER evaluation_gate_runs_immutable
BEFORE UPDATE OR DELETE ON evaluation_gate_runs
FOR EACH ROW EXECUTE FUNCTION prevent_evaluation_gate_run_mutation();

CREATE OR REPLACE FUNCTION prevent_evaluation_gate_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Evaluation Gate audit events are append-only' USING ERRCODE = '55000';
END $$;
DROP TRIGGER IF EXISTS evaluation_gate_audit_events_provenance ON evaluation_gate_audit_events;
CREATE TRIGGER evaluation_gate_audit_events_provenance
BEFORE INSERT ON evaluation_gate_audit_events
FOR EACH ROW EXECUTE FUNCTION enforce_retained_audit_project_provenance();
DROP TRIGGER IF EXISTS evaluation_gate_audit_events_immutable ON evaluation_gate_audit_events;
CREATE TRIGGER evaluation_gate_audit_events_immutable
BEFORE UPDATE OR DELETE ON evaluation_gate_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_evaluation_gate_audit_mutation();

CREATE OR REPLACE FUNCTION sync_evaluation_gate_outcome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    gate RECORD;
    v_selected_count INTEGER;
    v_evaluated_count INTEGER;
    v_passed_count INTEGER;
    v_failed_count INTEGER;
    next_status TEXT;
    next_reason TEXT;
BEGIN
    IF NEW.status NOT IN ('completed', 'failed', 'cancelled') THEN RETURN NEW; END IF;
    FOR gate IN
        SELECT * FROM evaluation_gate_runs
        WHERE evaluation_run_id = NEW.id AND project_id = NEW.project_id AND status = 'pending'
        FOR UPDATE
    LOOP
        IF NEW.status = 'cancelled' THEN
            next_status := 'cancelled';
            next_reason := COALESCE(NEW.terminal_reason, 'run_cancelled');
        ELSIF NEW.status = 'failed' THEN
            next_status := 'error';
            next_reason := COALESCE(NEW.terminal_reason, 'run_failed');
        ELSE
            SELECT count(*)::integer
            INTO v_selected_count
            FROM evaluation_run_items item
            WHERE item.run_id = NEW.id AND item.project_id = NEW.project_id;
            SELECT count(DISTINCT item.id) FILTER (WHERE result.status = 'completed')::integer,
                   count(DISTINCT item.id) FILTER (
                       WHERE result.status = 'completed'
                         AND EXISTS (
                             SELECT 1 FROM jsonb_each_text(result.scores) score
                             WHERE score.value ~ '^-?[0-9]+(\\.[0-9]+)?$'
                               AND score.value::numeric >= 1
                         )
                   )::integer
            INTO v_evaluated_count, v_passed_count
            FROM evaluation_run_items item
            LEFT JOIN experiment_tasks task
              ON task.evaluation_run_item_id = item.id
             AND task.project_id = item.project_id
             AND task.evaluation_run_id = NEW.id
            LEFT JOIN experiment_results result
              ON result.experiment_id = task.experiment_id
             AND result.project_id = task.project_id
             AND result.evaluation_run_item_id = item.id
            WHERE item.run_id = NEW.id AND item.project_id = NEW.project_id;
            v_failed_count := v_evaluated_count - v_passed_count;
            IF v_selected_count = 0 THEN
                next_status := 'inconclusive';
                next_reason := 'no_selected_evidence';
            ELSIF v_evaluated_count <> v_selected_count THEN
                next_status := 'inconclusive';
                next_reason := 'incomplete_evidence';
            ELSIF v_passed_count::numeric / v_evaluated_count >= gate.minimum_pass_rate THEN
                next_status := 'passed';
                next_reason := 'threshold_met';
            ELSE
                next_status := 'failed';
                next_reason := 'threshold_not_met';
            END IF;
        END IF;
        UPDATE evaluation_gate_runs
        SET status = next_status,
            outcome_reason = next_reason,
            selected_count = v_selected_count,
            evaluated_count = v_evaluated_count,
            passed_count = v_passed_count,
            failed_count = v_failed_count,
            updated_at = now()
        WHERE id = gate.id;
        INSERT INTO evaluation_gate_audit_events (
            organization_id, project_id, approval_id, gate_run_id,
            evaluation_run_id, definition_version_id, actor_id,
            event_type, gate_context, outcome_status
        ) VALUES (
            gate.organization_id, gate.project_id, gate.approval_id, gate.id,
            gate.evaluation_run_id, gate.definition_version_id, gate.requested_by_actor_id,
            'outcome_recorded', gate.gate_context, next_status
        );
    END LOOP;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS evaluation_gate_outcome_sync ON evaluation_runs;
CREATE TRIGGER evaluation_gate_outcome_sync
AFTER UPDATE OF status ON evaluation_runs
FOR EACH ROW EXECUTE FUNCTION sync_evaluation_gate_outcome();

-- Release-gate audit is retained as part of a Project's UUID provenance fence.
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
    ) THEN
        RAISE EXCEPTION 'project UUID has retained audit provenance' USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END;
$$;

-- Add a distinct operation so compatibility-mode Users can never approve,
-- revoke, or invoke a release gate merely because they can govern other data.
CREATE OR REPLACE FUNCTION authorization_allows_project(
    target_organization_id UUID,
    target_project_id UUID,
    target_actor_id UUID,
    operation TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    WITH decision AS (
        SELECT * FROM authorization_effective_project_role(
            target_organization_id, target_project_id, target_actor_id
        )
    )
    SELECT COALESCE((
        CASE
            WHEN effective_role IS NULL THEN false
            WHEN project_status <> 'active' THEN
                (effective_role = 'admin'
                 AND operation IN ('audit_read', 'project_manage', 'destructive'))
                OR (enforcement = 'compatibility'
                    AND effective_role = 'user'
                    AND operation IN ('project_manage', 'destructive'))
            WHEN effective_role = 'admin' THEN operation IN (
                'product_read', 'product_write', 'curation_write', 'execute', 'ingest', 'audit_read',
                'governed', 'release_gate_manage', 'destructive', 'project_manage'
            )
            WHEN enforcement = 'compatibility' AND effective_role = 'user' THEN operation IN (
                'product_read', 'product_write', 'curation_write', 'execute', 'ingest', 'audit_read',
                'project_manage', 'governed'
            )
            WHEN effective_role = 'user' THEN operation IN (
                'product_read', 'product_write', 'execute', 'ingest', 'audit_read'
            )
            WHEN enforcement = 'compatibility' AND effective_role = 'read_only' THEN operation IN (
                'product_read', 'product_write', 'execute', 'ingest'
            )
            WHEN effective_role = 'read_only' THEN operation IN ('product_read', 'audit_read')
            ELSE false
        END
    ), false)
    FROM decision
$$;

CREATE OR REPLACE FUNCTION authorization_allows_organization(
    target_organization_id UUID,
    target_actor_id UUID,
    operation TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM organization_actor_roles membership
        WHERE membership.organization_id = target_organization_id
          AND membership.actor_id = target_actor_id
          AND membership.role = 'admin'
          AND operation IN ('organization_manage', 'destructive', 'governed')
    )
$$;

COMMENT ON TABLE evaluation_gate_approvals IS
    'Project-scoped Admin approvals for immutable Evaluation Definition Versions; revoked approvals cannot authorize new gate work.';
COMMENT ON TABLE evaluation_gate_runs IS
    'Machine-readable release/CI gate invocations linked to one immutable Evaluation Run and terminal outcome.';
COMMENT ON TABLE evaluation_gate_audit_events IS
    'Content-safe append-only release-gate governance events; item payloads and provider secrets are never stored.';
