-- Rename the transaction-local authorization markers used by immutable-record
-- guards. Keep the guard behavior intact while moving the live functions to the
-- Glasshouse namespace; deployed databases have already applied the historical
-- definitions and will not rerun them.
CREATE OR REPLACE FUNCTION project_deletion_is_authorized(target_project_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT current_setting('glasshouse.project_deletion_id', true) = target_project_id::text
$$;

CREATE OR REPLACE FUNCTION dataset_retention_is_authorized(target_project_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    run_id_text TEXT := current_setting('glasshouse.dataset_retention_run_id', true);
    owner_token_text TEXT := current_setting('glasshouse.dataset_retention_owner_token', true);
BEGIN
    IF run_id_text IS NULL OR owner_token_text IS NULL
        OR run_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR owner_token_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN
        RETURN FALSE;
    END IF;
    RETURN EXISTS (
        SELECT 1
        FROM governance_retention_runs
        WHERE id = run_id_text::uuid
          AND project_id = target_project_id
          AND owner_token = owner_token_text::uuid
          AND status = 'running'
          AND lease_expires_at >= now()
    );
END
$$;

CREATE OR REPLACE FUNCTION prevent_dataset_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND (
        project_deletion_is_authorized(OLD.project_id)
        OR dataset_retention_is_authorized(OLD.project_id)
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'dataset snapshots are immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION prevent_dataset_lifecycle_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'dataset lifecycle audit events are append-only' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION prevent_dataset_tombstone_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'dataset tombstones are immutable' USING ERRCODE = '55000';
END
$$;

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
