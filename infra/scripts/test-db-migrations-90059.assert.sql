DO $$
DECLARE
    tenant UUID;
    principal UUID;
BEGIN
    SELECT id INTO tenant FROM organizations WHERE slug = 'default';
    SELECT id INTO principal FROM actors LIMIT 1;
    IF tenant IS NULL OR principal IS NULL THEN
        RAISE EXCEPTION 'missing snapshot migration fixture identity';
    END IF;
    IF to_regclass('public.internal_log_snapshots_expiry_idx') IS NULL THEN
        RAISE EXCEPTION 'snapshot expiry index is missing';
    END IF;
    BEGIN
        INSERT INTO internal_log_snapshots (id, organization_id, actor_id, filter_hash, signing_key, entry_ids, recorded_ats, expires_at)
        VALUES (gen_random_uuid(), tenant, principal, 'fixture', decode(repeat('01',32),'hex'), ARRAY[gen_random_uuid()], '{}'::timestamptz[], clock_timestamp());
        RAISE EXCEPTION 'mismatched snapshot arrays were accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO internal_log_snapshots (id, organization_id, actor_id, filter_hash, signing_key, entry_ids, recorded_ats, expires_at)
        VALUES (gen_random_uuid(), tenant, gen_random_uuid(), 'fixture', decode(repeat('01',32),'hex'), '{}'::uuid[], '{}'::timestamptz[], clock_timestamp());
        RAISE EXCEPTION 'unknown snapshot actor was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO internal_log_snapshots (id, organization_id, actor_id, filter_hash, signing_key, entry_ids, recorded_ats, expires_at)
        VALUES (gen_random_uuid(), tenant, principal, 'fixture', decode(repeat('01',32),'hex'), array_fill(gen_random_uuid(), ARRAY[50001]), array_fill(clock_timestamp(), ARRAY[50001]), clock_timestamp());
        RAISE EXCEPTION 'oversized snapshot was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END;
$$;
