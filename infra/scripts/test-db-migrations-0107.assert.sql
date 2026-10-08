BEGIN;
DO $$
DECLARE
    target_project_id UUID := '10700000-0000-4000-8000-000000000003';
    other_project_id UUID := '11111111-1111-1111-1111-111111111111';
    policy_version_id UUID;
    retention_run_id UUID := '10700000-0000-4000-8000-000000000001';
    owner_token UUID := '10700000-0000-4000-8000-000000000002';
BEGIN
    INSERT INTO projects (id, organization_id, name, slug)
    VALUES (
        target_project_id,
        '00000000-0000-4000-8000-000000000001',
        'Guard namespace fixture',
        'guard-namespace-fixture'
    );

    SELECT id INTO policy_version_id
    FROM governance_policy_versions
    WHERE project_id = target_project_id
    ORDER BY version DESC
    LIMIT 1;
    IF policy_version_id IS NULL THEN
        RAISE EXCEPTION '0107 fixture project has no governance policy version';
    END IF;

    INSERT INTO governance_retention_runs (
        id, organization_id, project_id, policy_version_id, requested_by,
        status, owner_token, heartbeat_at, lease_expires_at
    ) VALUES (
        retention_run_id, '00000000-0000-4000-8000-000000000001',
        target_project_id, policy_version_id, 'migration-test', 'running',
        owner_token, now(), now() + interval '5 minutes'
    );

    PERFORM set_config('glasshouse.dataset_retention_run_id', retention_run_id::text, true);
    PERFORM set_config('glasshouse.dataset_retention_owner_token', '10700000-0000-4000-8000-000000000003', true);
    IF dataset_retention_is_authorized(target_project_id) IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION '0107 accepted a mismatched retention owner token';
    END IF;
    PERFORM set_config('glasshouse.dataset_retention_owner_token', owner_token::text, true);
    IF dataset_retention_is_authorized(other_project_id) IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION '0107 accepted a cross-project retention context';
    END IF;
    IF dataset_retention_is_authorized(target_project_id) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION '0107 rejected the matching active retention context';
    END IF;

    PERFORM set_config('glasshouse.project_deletion_id', target_project_id::text, true);
    IF project_deletion_is_authorized(target_project_id) IS DISTINCT FROM TRUE
       OR project_deletion_is_authorized(other_project_id) IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION '0107 project deletion marker did not remain project-scoped';
    END IF;

    UPDATE governance_retention_runs
    SET lease_expires_at = now() - interval '1 second'
    WHERE id = retention_run_id;
    IF dataset_retention_is_authorized(target_project_id) IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION '0107 accepted an expired retention lease';
    END IF;
END;
$$;
ROLLBACK;
