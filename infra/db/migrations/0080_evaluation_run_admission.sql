-- P3.2: persist an immutable Evaluation Run admission contract before queueing.
CREATE TABLE IF NOT EXISTS evaluation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    evaluation_id UUID NOT NULL,
    definition_version_id UUID NOT NULL,
    dataset_version_id UUID NOT NULL,
    requested_by_actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    resolved_inputs_hash TEXT NOT NULL CHECK (resolved_inputs_hash ~ '^[0-9a-f]{64}$'),
    trigger_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(trigger_metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, idempotency_key),
    UNIQUE (id, project_id),
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (evaluation_id, project_id)
        REFERENCES evaluations(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (definition_version_id, project_id)
        REFERENCES evaluation_definition_versions(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, dataset_version_id)
        REFERENCES dataset_versions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS evaluation_run_inputs (
    run_id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    target JSONB NOT NULL CHECK (jsonb_typeof(target) = 'object'),
    target_version TEXT NOT NULL CHECK (length(target_version) BETWEEN 1 AND 64),
    target_fingerprint TEXT NOT NULL CHECK (target_fingerprint ~ '^[0-9a-f]{64}$'),
    evaluator JSONB NOT NULL CHECK (jsonb_typeof(evaluator) = 'object'),
    evaluator_version TEXT NOT NULL CHECK (length(evaluator_version) BETWEEN 1 AND 64),
    execution_defaults JSONB NOT NULL CHECK (jsonb_typeof(execution_defaults) = 'object'),
    thresholds JSONB NOT NULL CHECK (jsonb_typeof(thresholds) = 'object'),
    sampling JSONB NOT NULL CHECK (jsonb_typeof(sampling) = 'object'),
    sample_identity TEXT NOT NULL CHECK (sample_identity ~ '^[0-9a-f]{64}$'),
    ordered_item_snapshot JSONB NOT NULL
        CHECK (jsonb_typeof(ordered_item_snapshot) = 'array'),
    resolved_inputs_hash TEXT NOT NULL CHECK (resolved_inputs_hash ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, project_id),
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, project_id)
        REFERENCES evaluation_runs(id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS evaluation_run_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    run_id UUID NOT NULL,
    dataset_version_item_id UUID NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    item_key TEXT NOT NULL,
    input JSONB NOT NULL CHECK (jsonb_typeof(input) = 'object'),
    expected_output JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    source_trace_id TEXT,
    source_observation_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, position),
    UNIQUE (run_id, dataset_version_item_id),
    UNIQUE (run_id, item_key),
    UNIQUE (id, project_id),
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, project_id)
        REFERENCES evaluation_runs(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, dataset_version_item_id)
        REFERENCES dataset_version_items(project_id, id) ON DELETE RESTRICT
);

ALTER TABLE experiments ADD COLUMN IF NOT EXISTS evaluation_run_id UUID;
ALTER TABLE experiment_tasks ADD COLUMN IF NOT EXISTS evaluation_run_item_id UUID;
ALTER TABLE experiment_results ADD COLUMN IF NOT EXISTS evaluation_run_item_id UUID;
ALTER TABLE experiments DROP CONSTRAINT IF EXISTS experiments_project_evaluation_run_fkey;
ALTER TABLE experiments ADD CONSTRAINT experiments_project_evaluation_run_fkey
    FOREIGN KEY (evaluation_run_id, project_id)
    REFERENCES evaluation_runs(id, project_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS experiments_evaluation_run_id_key
    ON experiments(evaluation_run_id) WHERE evaluation_run_id IS NOT NULL;
ALTER TABLE experiment_tasks DROP CONSTRAINT IF EXISTS experiment_tasks_evaluation_run_item_fkey;
ALTER TABLE experiment_tasks ADD CONSTRAINT experiment_tasks_evaluation_run_item_fkey
    FOREIGN KEY (evaluation_run_item_id, project_id)
    REFERENCES evaluation_run_items(id, project_id) ON DELETE RESTRICT;
ALTER TABLE experiment_results DROP CONSTRAINT IF EXISTS experiment_results_evaluation_run_item_fkey;
ALTER TABLE experiment_results ADD CONSTRAINT experiment_results_evaluation_run_item_fkey
    FOREIGN KEY (evaluation_run_item_id, project_id)
    REFERENCES evaluation_run_items(id, project_id) ON DELETE RESTRICT;

ALTER TABLE benchmark_runs ADD COLUMN IF NOT EXISTS evaluation_run_id UUID;
ALTER TABLE benchmark_runs DROP CONSTRAINT IF EXISTS benchmark_runs_project_evaluation_run_fkey;
ALTER TABLE benchmark_runs ADD CONSTRAINT benchmark_runs_project_evaluation_run_fkey
    FOREIGN KEY (evaluation_run_id, project_id)
    REFERENCES evaluation_runs(id, project_id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS benchmark_runs_evaluation_run_id_idx
    ON benchmark_runs(evaluation_run_id) WHERE evaluation_run_id IS NOT NULL;

-- Preserve the existing versioned binding path for historical/new callers, but
-- seed admitted runs only from their immutable item snapshot.
CREATE OR REPLACE FUNCTION seed_experiment_tasks() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.evaluation_run_id IS NOT NULL THEN
        INSERT INTO experiment_tasks (project_id, experiment_id, evaluation_run_item_id, dataset_version_item_id)
        SELECT NEW.project_id, NEW.id, item.id, item.dataset_version_item_id
        FROM evaluation_run_items item
        WHERE item.project_id = NEW.project_id
          AND item.run_id = NEW.evaluation_run_id
        ON CONFLICT (experiment_id, dataset_version_item_id)
            WHERE dataset_version_item_id IS NOT NULL DO NOTHING;
        RETURN NEW;
    END IF;

    IF NEW.dataset_input_binding <> 'versioned' OR NEW.resolved_dataset_version_id IS NULL THEN
        RETURN NEW;
    END IF;
    INSERT INTO experiment_tasks (project_id, experiment_id, dataset_version_item_id)
    SELECT NEW.project_id, NEW.id, item.id
    FROM dataset_version_items item
    WHERE item.project_id = NEW.project_id
      AND item.dataset_version_id = NEW.resolved_dataset_version_id
    ON CONFLICT (experiment_id, dataset_version_item_id)
        WHERE dataset_version_item_id IS NOT NULL DO NOTHING;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION prevent_evaluation_run_input_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF current_setting('glasshouse.evaluation_run_admission_run_id', true)
            IS DISTINCT FROM NEW.run_id::text
            OR EXISTS (
                SELECT 1
                FROM experiments experiment
                WHERE experiment.evaluation_run_id = NEW.run_id
                  AND experiment.project_id = NEW.project_id
            ) THEN
            RAISE EXCEPTION 'evaluation run inputs can only be admitted once'
                USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'evaluation run inputs are immutable' USING ERRCODE = '55000';
END $$;
DROP TRIGGER IF EXISTS evaluation_run_inputs_immutable ON evaluation_run_inputs;
CREATE TRIGGER evaluation_run_inputs_immutable
BEFORE INSERT OR UPDATE OR DELETE ON evaluation_run_inputs
FOR EACH ROW EXECUTE FUNCTION prevent_evaluation_run_input_mutation();
DROP TRIGGER IF EXISTS evaluation_run_items_immutable ON evaluation_run_items;
CREATE TRIGGER evaluation_run_items_immutable
BEFORE INSERT OR UPDATE OR DELETE ON evaluation_run_items
FOR EACH ROW EXECUTE FUNCTION prevent_evaluation_run_input_mutation();

CREATE OR REPLACE FUNCTION prevent_evaluation_run_contract_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN RETURN OLD; END IF;
    IF TG_OP = 'UPDATE' AND (
        NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
        NEW.project_id IS DISTINCT FROM OLD.project_id OR
        NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id OR
        NEW.definition_version_id IS DISTINCT FROM OLD.definition_version_id OR
        NEW.dataset_version_id IS DISTINCT FROM OLD.dataset_version_id OR
        NEW.requested_by_actor_id IS DISTINCT FROM OLD.requested_by_actor_id OR
        NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
        NEW.request_hash IS DISTINCT FROM OLD.request_hash OR
        NEW.resolved_inputs_hash IS DISTINCT FROM OLD.resolved_inputs_hash OR
        NEW.trigger_metadata IS DISTINCT FROM OLD.trigger_metadata
    ) THEN
        RAISE EXCEPTION 'evaluation run admission contract is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS evaluation_runs_contract_immutable ON evaluation_runs;
CREATE TRIGGER evaluation_runs_contract_immutable
BEFORE UPDATE OR DELETE ON evaluation_runs
FOR EACH ROW EXECUTE FUNCTION prevent_evaluation_run_contract_mutation();

CREATE OR REPLACE FUNCTION prevent_evaluation_run_experiment_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN RETURN OLD; END IF;
    IF TG_OP = 'UPDATE' AND OLD.evaluation_run_id IS NOT NULL AND (
        NEW.project_id IS DISTINCT FROM OLD.project_id OR
        NEW.dataset_id IS DISTINCT FROM OLD.dataset_id OR
        NEW.resolved_dataset_version_id IS DISTINCT FROM OLD.resolved_dataset_version_id OR
        NEW.dataset_input_binding IS DISTINCT FROM OLD.dataset_input_binding OR
        NEW.config IS DISTINCT FROM OLD.config OR
        NEW.requested_by_actor_id IS DISTINCT FROM OLD.requested_by_actor_id OR
        NEW.evaluation_run_id IS DISTINCT FROM OLD.evaluation_run_id
    ) THEN
        RAISE EXCEPTION 'evaluation run experiment contract is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS evaluation_run_experiment_immutable ON experiments;
CREATE TRIGGER evaluation_run_experiment_immutable
BEFORE UPDATE OR DELETE ON experiments
FOR EACH ROW EXECUTE FUNCTION prevent_evaluation_run_experiment_mutation();

CREATE OR REPLACE FUNCTION sync_evaluation_run_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.evaluation_run_id IS NOT NULL AND NEW.status IN ('pending', 'running', 'completed', 'failed', 'cancelled') THEN
        UPDATE evaluation_runs
        SET status = NEW.status, updated_at = now()
        WHERE id = NEW.evaluation_run_id AND project_id = NEW.project_id;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS evaluation_run_status_sync ON experiments;
CREATE TRIGGER evaluation_run_status_sync
AFTER INSERT OR UPDATE OF status ON experiments
FOR EACH ROW EXECUTE FUNCTION sync_evaluation_run_status();

CREATE OR REPLACE FUNCTION enforce_evaluation_run_requester_actor_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM projects project
        JOIN actor_identities identity
          ON identity.organization_id = project.organization_id
         AND identity.actor_id = NEW.requested_by_actor_id
         AND identity.provider_namespace = 'basic:v1'
        WHERE project.id = NEW.project_id
          AND project.organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'evaluation run requester actor is not scoped to the project organization';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS evaluation_runs_requester_actor_scope ON evaluation_runs;
CREATE TRIGGER evaluation_runs_requester_actor_scope
BEFORE INSERT OR UPDATE OF organization_id, project_id, requested_by_actor_id ON evaluation_runs
FOR EACH ROW EXECUTE FUNCTION enforce_evaluation_run_requester_actor_scope();

CREATE INDEX IF NOT EXISTS evaluation_runs_project_created_idx
    ON evaluation_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS evaluation_runs_definition_version_idx
    ON evaluation_runs(project_id, definition_version_id);
CREATE INDEX IF NOT EXISTS evaluation_run_items_run_position_idx
    ON evaluation_run_items(project_id, run_id, position);
