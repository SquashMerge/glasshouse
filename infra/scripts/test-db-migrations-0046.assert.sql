DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'execution_admission_claims'
          AND column_name = 'effect_key'
          AND is_nullable = 'NO'
    ) THEN
        RAISE EXCEPTION '0046 did not require execution effect keys';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE tablename = 'execution_admission_claims'
          AND indexname = 'execution_admission_claims_effect_key_unique'
    ) THEN
        RAISE EXCEPTION '0046 did not make execution effect keys unique';
    END IF;

    IF (SELECT effect_key FROM execution_admission_claims WHERE id = '46000000-0000-4000-8000-000000000003')
        <> '46000000-0000-4000-8000-000000000003' THEN
        RAISE EXCEPTION '0046 did not deterministically backfill existing effect claims';
    END IF;

    BEGIN
        INSERT INTO execution_admission_claims (
            id, admission_id, effect, effect_key, authorization_epoch, expires_at
        ) VALUES (
            '46000000-0000-4000-8000-000000000004',
            '46000000-0000-4000-8000-000000000001',
            'provider_dispatch',
            '46000000-0000-4000-8000-000000000003',
            1,
            now() + interval '1 minute'
        );
        RAISE EXCEPTION '0046 accepted a duplicate stable effect key';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END
$$;
