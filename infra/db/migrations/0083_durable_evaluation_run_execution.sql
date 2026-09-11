-- P3.3: make admitted Evaluation Runs durable worker work, not only an
-- immutable admission snapshot. Legacy Experiments remain compatibility rows.
-- API consumers replay the event stream with Last-Event-ID.

ALTER TABLE evaluation_runs
    ADD COLUMN IF NOT EXISTS terminal_reason TEXT;

ALTER TABLE evaluation_run_inputs
    ADD COLUMN IF NOT EXISTS limits JSONB NOT NULL
        DEFAULT '{"max_cost_usd":10,"max_duration_seconds":3600}'::jsonb;
ALTER TABLE evaluation_run_inputs
    DROP CONSTRAINT IF EXISTS evaluation_run_inputs_limits_check;
ALTER TABLE evaluation_run_inputs
    ADD CONSTRAINT evaluation_run_inputs_limits_check
    CHECK (jsonb_typeof(limits) = 'object');

ALTER TABLE experiment_tasks
    ADD COLUMN IF NOT EXISTS evaluation_run_id UUID,
    ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_error_classification TEXT,
    ADD COLUMN IF NOT EXISTS last_error_message TEXT;

UPDATE experiment_tasks task
SET evaluation_run_id = experiment.evaluation_run_id
FROM experiments experiment
WHERE experiment.id = task.experiment_id
  AND experiment.project_id = task.project_id
  AND experiment.evaluation_run_id IS NOT NULL
  AND task.evaluation_run_id IS NULL;

ALTER TABLE experiment_tasks
    DROP CONSTRAINT IF EXISTS experiment_tasks_evaluation_run_fkey;
ALTER TABLE experiment_tasks
    ADD CONSTRAINT experiment_tasks_evaluation_run_fkey
    FOREIGN KEY (evaluation_run_id, project_id)
    REFERENCES evaluation_runs(id, project_id) ON DELETE RESTRICT;
ALTER TABLE experiment_tasks
    DROP CONSTRAINT IF EXISTS experiment_tasks_attempt_policy_check;
ALTER TABLE experiment_tasks
    ADD CONSTRAINT experiment_tasks_attempt_policy_check
    CHECK (max_attempts BETWEEN 1 AND 10 AND next_attempt_at IS NOT NULL);
ALTER TABLE experiment_tasks
    DROP CONSTRAINT IF EXISTS experiment_tasks_error_message_check;
ALTER TABLE experiment_tasks
    ADD CONSTRAINT experiment_tasks_error_message_check
    CHECK (last_error_message IS NULL OR length(last_error_message) <= 512);

ALTER TABLE experiment_results
    ADD COLUMN IF NOT EXISTS evaluation_run_id UUID,
    ADD COLUMN IF NOT EXISTS trace_id TEXT,
    ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12, 6),
    ADD COLUMN IF NOT EXISTS error_classification TEXT,
    ADD COLUMN IF NOT EXISTS error_message TEXT,
    ADD COLUMN IF NOT EXISTS evaluator_rationale JSONB;

UPDATE experiment_results result
SET evaluation_run_id = experiment.evaluation_run_id
FROM experiments experiment
WHERE experiment.id = result.experiment_id
  AND experiment.project_id = result.project_id
  AND experiment.evaluation_run_id IS NOT NULL
  AND result.evaluation_run_id IS NULL;

ALTER TABLE experiment_results
    DROP CONSTRAINT IF EXISTS experiment_results_evaluation_run_fkey;
ALTER TABLE experiment_results
    ADD CONSTRAINT experiment_results_evaluation_run_fkey
    FOREIGN KEY (evaluation_run_id, project_id)
    REFERENCES evaluation_runs(id, project_id) ON DELETE RESTRICT;
ALTER TABLE experiment_results
    DROP CONSTRAINT IF EXISTS experiment_results_evidence_check;
ALTER TABLE experiment_results
    ADD CONSTRAINT experiment_results_evidence_check
    CHECK (
        (cost_usd IS NULL OR cost_usd >= 0)
        AND (error_message IS NULL OR length(error_message) <= 512)
        AND (evaluator_rationale IS NULL OR jsonb_typeof(evaluator_rationale) = 'object')
    );

CREATE UNIQUE INDEX IF NOT EXISTS experiment_tasks_evaluation_run_item_key
    ON experiment_tasks(project_id, evaluation_run_id, evaluation_run_item_id)
    WHERE evaluation_run_id IS NOT NULL AND evaluation_run_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS experiment_tasks_evaluation_run_claimable_idx
    ON experiment_tasks(project_id, evaluation_run_id, status, next_attempt_at, lease_expires_at, created_at)
    WHERE evaluation_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS experiment_results_evaluation_run_idx
    ON experiment_results(project_id, evaluation_run_id, created_at)
    WHERE evaluation_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION seed_experiment_tasks() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.evaluation_run_id IS NOT NULL THEN
        INSERT INTO experiment_tasks (
            project_id, experiment_id, evaluation_run_id,
            evaluation_run_item_id, dataset_version_item_id
        )
        SELECT NEW.project_id, NEW.id, NEW.evaluation_run_id,
            item.id, item.dataset_version_item_id
        FROM evaluation_run_items item
        WHERE item.project_id = NEW.project_id
          AND item.run_id = NEW.evaluation_run_id
        ON CONFLICT (experiment_id, dataset_version_item_id)
            WHERE dataset_version_item_id IS NOT NULL DO NOTHING;
        RETURN NEW;
    END IF;
    INSERT INTO experiment_tasks (project_id, experiment_id, dataset_version_item_id)
    SELECT NEW.project_id, NEW.id, item.id
    FROM dataset_versions version
    JOIN dataset_version_items item
      ON item.project_id = version.project_id
     AND item.dataset_version_id = version.id
    WHERE version.project_id = NEW.project_id
      AND version.dataset_id = NEW.dataset_id
      AND version.id = NEW.resolved_dataset_version_id
    ON CONFLICT (experiment_id, dataset_version_item_id)
        WHERE dataset_version_item_id IS NOT NULL DO NOTHING;
    RETURN NEW;
END $$;

CREATE TABLE IF NOT EXISTS evaluation_run_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    run_id UUID NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('run_status', 'task_status', 'result_recorded')),
    task_id UUID,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(payload) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, project_id)
        REFERENCES evaluation_runs(id, project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS evaluation_run_events_replay_idx
    ON evaluation_run_events(project_id, run_id, id);

CREATE OR REPLACE FUNCTION enforce_evaluation_run_status_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = NEW.status THEN RETURN NEW; END IF;
    IF NOT (
        (OLD.status = 'pending' AND NEW.status IN ('running', 'failed', 'cancelled'))
        OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'cancelled'))
        OR (OLD.status = 'failed' AND NEW.status = 'running')
    ) THEN
        RAISE EXCEPTION 'invalid Evaluation Run status transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS evaluation_run_status_transition ON evaluation_runs;
CREATE TRIGGER evaluation_run_status_transition
BEFORE UPDATE OF status ON evaluation_runs
FOR EACH ROW EXECUTE FUNCTION enforce_evaluation_run_status_transition();

CREATE OR REPLACE FUNCTION enforce_evaluation_run_task_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = NEW.status THEN RETURN NEW; END IF;
    IF NOT (
        (OLD.status = 'pending' AND NEW.status IN ('running', 'cancelled'))
        OR (OLD.status = 'running' AND NEW.status IN ('pending', 'completed', 'failed', 'cancelled'))
        OR (OLD.status = 'failed' AND NEW.status = 'pending')
    ) THEN
        RAISE EXCEPTION 'invalid Evaluation Run task status transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS evaluation_run_task_status_transition ON experiment_tasks;
CREATE TRIGGER evaluation_run_task_status_transition
BEFORE UPDATE OF status ON experiment_tasks
FOR EACH ROW EXECUTE FUNCTION enforce_evaluation_run_task_transition();

CREATE OR REPLACE FUNCTION record_evaluation_run_status_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO evaluation_run_events (
            organization_id, project_id, run_id, event_type, payload
        ) VALUES (
            NEW.organization_id, NEW.project_id, NEW.id, 'run_status',
            jsonb_build_object('run_id', NEW.id, 'status', NEW.status)
        );
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS evaluation_run_status_event ON evaluation_runs;
CREATE TRIGGER evaluation_run_status_event
AFTER INSERT OR UPDATE OF status ON evaluation_runs
FOR EACH ROW EXECUTE FUNCTION record_evaluation_run_status_event();

CREATE OR REPLACE FUNCTION record_evaluation_run_task_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    run_id UUID;
    organization_id UUID;
BEGIN
    run_id := NEW.evaluation_run_id;
    IF run_id IS NULL THEN RETURN NEW; END IF;
    SELECT run.organization_id INTO organization_id
    FROM evaluation_runs run
    WHERE run.id = run_id AND run.project_id = NEW.project_id;
    IF organization_id IS NULL THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO evaluation_run_events (
            organization_id, project_id, run_id, event_type, task_id, payload
        ) VALUES (
            organization_id, NEW.project_id, run_id, 'task_status', NEW.id,
            jsonb_build_object(
                'run_id', run_id,
                'task_id', NEW.id,
                'status', NEW.status,
                'attempt_count', NEW.attempt_count
            )
        );
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS evaluation_run_task_event ON experiment_tasks;
CREATE TRIGGER evaluation_run_task_event
AFTER INSERT OR UPDATE OF status ON experiment_tasks
FOR EACH ROW EXECUTE FUNCTION record_evaluation_run_task_event();

CREATE OR REPLACE FUNCTION record_evaluation_run_result_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    run_id UUID;
BEGIN
    run_id := NEW.evaluation_run_id;
    IF run_id IS NULL THEN RETURN NEW; END IF;
    INSERT INTO evaluation_run_events (
        organization_id, project_id, run_id, event_type, task_id, payload
    )
    SELECT run.organization_id, NEW.project_id, run.id, 'result_recorded', task.id,
        jsonb_build_object(
            'run_id', run.id,
            'task_id', task.id,
            'status', NEW.status
        )
    FROM evaluation_runs run
    LEFT JOIN experiment_tasks task
      ON task.evaluation_run_item_id = NEW.evaluation_run_item_id
     AND task.evaluation_run_id = run.id
     AND task.project_id = NEW.project_id
    WHERE run.id = run_id AND run.project_id = NEW.project_id;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS evaluation_run_result_event ON experiment_results;
CREATE TRIGGER evaluation_run_result_event
AFTER INSERT OR UPDATE OF status ON experiment_results
FOR EACH ROW EXECUTE FUNCTION record_evaluation_run_result_event();
