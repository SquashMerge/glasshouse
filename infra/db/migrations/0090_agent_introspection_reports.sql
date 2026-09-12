-- P4 #166a: one immutable, client-reported introspection report per durable
-- Evaluation Run task invocation. This is not an Agent registry or event log.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'experiment_tasks_id_project_run_item_key'
    ) THEN
        ALTER TABLE experiment_tasks
            ADD CONSTRAINT experiment_tasks_id_project_run_item_key
            UNIQUE (id, project_id, evaluation_run_id, evaluation_run_item_id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS agent_introspection_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    evaluation_run_id UUID NOT NULL,
    evaluation_run_item_id UUID NOT NULL,
    task_id UUID NOT NULL,
    invocation_id UUID NOT NULL,
    reported_by_actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    contract_version TEXT NOT NULL CHECK (contract_version = 'agent-introspection.v1'),
    source TEXT NOT NULL CHECK (source = 'client_reported'),
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'unknown')),
    completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'partial', 'unknown')),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, evaluation_run_id, task_id, invocation_id),
    UNIQUE (id, project_id),
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (evaluation_run_id, project_id)
        REFERENCES evaluation_runs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, project_id, evaluation_run_id, evaluation_run_item_id)
        REFERENCES experiment_tasks(id, project_id, evaluation_run_id, evaluation_run_item_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS agent_introspection_reports_lookup_idx
    ON agent_introspection_reports(project_id, evaluation_run_id, task_id, invocation_id);

CREATE OR REPLACE FUNCTION enforce_agent_introspection_report_actor_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM actor_identities
        WHERE actor_id = NEW.reported_by_actor_id
          AND organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'agent introspection report actor is not scoped to the organization';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS agent_introspection_reports_actor_scope ON agent_introspection_reports;
CREATE TRIGGER agent_introspection_reports_actor_scope
BEFORE INSERT OR UPDATE OF organization_id, reported_by_actor_id ON agent_introspection_reports
FOR EACH ROW EXECUTE FUNCTION enforce_agent_introspection_report_actor_scope();

CREATE OR REPLACE FUNCTION prevent_agent_introspection_report_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'agent introspection reports are immutable' USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS agent_introspection_reports_immutable ON agent_introspection_reports;
CREATE TRIGGER agent_introspection_reports_immutable
BEFORE UPDATE OR DELETE ON agent_introspection_reports
FOR EACH ROW EXECUTE FUNCTION prevent_agent_introspection_report_mutation();
