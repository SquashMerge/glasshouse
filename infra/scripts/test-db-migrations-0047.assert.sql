DO $$
DECLARE
    first_effect UUID;
    second_effect UUID;
    isolated_effect UUID;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'execution_effects'::regclass
          AND conname = 'execution_effects_logical_operation_unique'
    ) THEN
        RAISE EXCEPTION '0047 did not enforce durable logical effect uniqueness';
    END IF;

    IF (
        SELECT count(*)
        FROM execution_effects
        WHERE organization_id = '44000000-0000-4000-8000-000000000001'
          AND project_id = '44000000-0000-4000-8000-000000000002'
          AND work_kind = 'experiment_task'
          AND work_id = '46000000-0000-4000-8000-000000000002'
          AND effect = 'provider_dispatch'
          AND operation_key = '46000000-0000-4000-8000-000000000003'
    ) <> 1 THEN
        RAISE EXCEPTION '0047 did not coalesce replayed admission effects';
    END IF;

    SELECT execution_effect_id INTO first_effect
    FROM execution_admission_claims
    WHERE id = '46000000-0000-4000-8000-000000000003';
    SELECT execution_effect_id INTO second_effect
    FROM execution_admission_claims
    WHERE id = '47000000-0000-4000-8000-000000000002';
    IF first_effect IS NULL OR first_effect <> second_effect THEN
        RAISE EXCEPTION '0047 did not link replayed claims to one durable effect';
    END IF;

    SELECT execution_effect_id INTO isolated_effect
    FROM execution_admission_claims
    WHERE id = '47000000-0000-4000-8000-000000000007';
    IF isolated_effect IS NULL OR isolated_effect = first_effect OR NOT EXISTS (
        SELECT 1
        FROM execution_effects
        WHERE id = isolated_effect
          AND organization_id = '47000000-0000-4000-8000-000000000003'
          AND project_id = '47000000-0000-4000-8000-000000000005'
          AND work_kind = 'experiment_task'
          AND work_id = '46000000-0000-4000-8000-000000000002'
          AND effect = 'provider_dispatch'
          AND operation_key = '46000000-0000-4000-8000-000000000003'
    ) THEN
        RAISE EXCEPTION '0047 did not isolate legacy claim effect backfills by tenant';
    END IF;

    BEGIN
        INSERT INTO execution_effects (
            organization_id, project_id, work_kind, work_id, effect, operation_key
        ) VALUES (
            '44000000-0000-4000-8000-000000000001',
            '44000000-0000-4000-8000-000000000002',
            'experiment_task',
            '46000000-0000-4000-8000-000000000002',
            'provider_dispatch',
            '46000000-0000-4000-8000-000000000003'
        );
        RAISE EXCEPTION '0047 accepted a duplicate logical effect';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END
$$;
