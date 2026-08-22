DO $$
DECLARE
    fixture_experiment_id UUID := '72000000-0000-4000-8000-000000000006';
    fixture_admission_id UUID := '72000000-0000-4000-8000-000000000007';
BEGIN
    IF EXISTS (
        SELECT 1 FROM experiments
        WHERE id = fixture_experiment_id
          AND (dataset_input_binding <> 'legacy_unversioned' OR status <> 'cancelled')
    ) THEN
        RAISE EXCEPTION '0072 did not truthfully terminalize the legacy experiment';
    END IF;
    IF EXISTS (
        SELECT 1 FROM experiment_tasks
        WHERE experiment_id = fixture_experiment_id AND status <> 'cancelled'
    ) THEN
        RAISE EXCEPTION '0072 did not terminalize legacy experiment tasks';
    END IF;
    IF EXISTS (
        SELECT 1 FROM execution_admissions
        WHERE id = fixture_admission_id
          AND (status <> 'cancelled' OR cancelled_at IS NULL)
    ) THEN
        RAISE EXCEPTION '0072 left an active admission able to claim or finalize legacy work';
    END IF;
    UPDATE execution_admissions
    SET status = 'completed', completed_at = now()
    WHERE id = fixture_admission_id AND status = 'active';
    IF FOUND THEN
        RAISE EXCEPTION '0072 allowed a cancelled legacy admission to finalize';
    END IF;
END
$$;
