-- Allow ordinary cleanup of experiments that were never admitted to an Evaluation Run.
CREATE OR REPLACE FUNCTION prevent_evaluation_run_experiment_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.evaluation_run_id IS NOT NULL
           AND NOT project_deletion_is_authorized(OLD.project_id) THEN
            RAISE EXCEPTION 'evaluation run experiment contract is immutable'
                USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.evaluation_run_id IS NOT NULL AND (
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
