BEGIN;
DO $$
DECLARE
    wrapper_definition TEXT;
    policy_definition TEXT;
    fixture_organization_id CONSTANT UUID := '00000000-0000-4000-8000-000000000001';
    fixture_project_id CONSTANT UUID := '88000000-0000-4000-8000-000000000001';
    fixture_actor_id UUID;
    fixture_role TEXT;
    strict_mode BOOLEAN;
BEGIN
    IF to_regclass('public.evaluation_gate_approvals') IS NULL
       OR to_regclass('public.evaluation_gate_runs') IS NULL
       OR to_regclass('public.evaluation_gate_audit_events') IS NULL THEN
        RAISE EXCEPTION '0088 Evaluation Gate tables are missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE relname = 'evaluation_gate_approvals_active_scope_idx' AND relkind = 'i'
    ) THEN
        RAISE EXCEPTION '0088 active approval uniqueness index is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'evaluation_gate_approvals'::regclass
          AND conkey = ARRAY[
              (SELECT attnum FROM pg_attribute WHERE attrelid = 'evaluation_gate_approvals'::regclass AND attname = 'superseded_by'),
              (SELECT attnum FROM pg_attribute WHERE attrelid = 'evaluation_gate_approvals'::regclass AND attname = 'project_id')
          ]
          AND condeferrable
          AND condeferred
    ) THEN
        RAISE EXCEPTION '0088 supersession foreign key must defer until replacement approval insertion';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'evaluation_gate_outcome_sync'
    ) THEN
        RAISE EXCEPTION '0088 gate outcome trigger is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'evaluation_gate_approvals'
          AND column_name = 'definition_version_id'
          AND is_nullable = 'NO'
    ) THEN
        RAISE EXCEPTION '0088 approval immutable Definition Version binding is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'evaluation_gate_runs'
          AND column_name IN ('selected_count', 'evaluated_count', 'passed_count', 'failed_count')
        GROUP BY table_name
        HAVING count(*) = 4
    ) THEN
        RAISE EXCEPTION '0088 gate outcome counts are missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE proname = 'sync_evaluation_gate_outcome'
          AND prosrc LIKE '%incomplete_evidence%'
    ) THEN
        RAISE EXCEPTION '0088 incomplete evidence gate outcome is missing';
    END IF;
    wrapper_definition := pg_get_functiondef(
        'public.authorization_allows_project(uuid,uuid,uuid,text)'::regprocedure
    );
    IF wrapper_definition !~ E'SELECT\\s+local_actor_authentication_enabled\\(target_organization_id, target_actor_id\\)\\s+AND\\s+authorization_allows_project_before_local_sessions\\(target_organization_id, target_project_id, target_actor_id, operation\\)' THEN
        RAISE EXCEPTION '0101 project authorization wrapper must fence credentials and delegate unchanged arguments';
    END IF;
    policy_definition := pg_get_functiondef(
        'public.authorization_allows_project_before_local_sessions(uuid,uuid,uuid,text)'::regprocedure
    );
    IF policy_definition !~ E'WHEN\\s+effective_role\\s*=\\s*''admin''\\s+THEN\\s+operation\\s+IN\\s*\\([^)]*''release_gate_manage''' THEN
        RAISE EXCEPTION '0088 Admin-only release_gate_manage authorization is missing';
    END IF;

    -- Exercise the public wrapper in both modes, not just its source text.
    INSERT INTO projects (id, organization_id, name, slug)
    VALUES (fixture_project_id, fixture_organization_id, 'Release Gate Authorization Fixture', 'release-gate-authorization-fixture');
    FOREACH fixture_role IN ARRAY ARRAY['admin', 'user', 'read_only'] LOOP
        fixture_actor_id := gen_random_uuid();
        INSERT INTO actors (id) VALUES (fixture_actor_id);
        INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
        VALUES (fixture_actor_id, fixture_organization_id, 'basic:v1', 'release-gate-' || fixture_role);
        INSERT INTO organization_actor_roles (organization_id, actor_id, role)
        VALUES (fixture_organization_id, fixture_actor_id, fixture_role);
        IF fixture_role <> 'admin' THEN
            INSERT INTO project_actor_grants (project_id, organization_id, actor_id, role)
            VALUES (fixture_project_id, fixture_organization_id, fixture_actor_id, fixture_role);
        END IF;
        FOREACH strict_mode IN ARRAY ARRAY[false, true] LOOP
            UPDATE authorization_policy_settings
            SET strict_enforcement = strict_mode, enabled_at = COALESCE(enabled_at, now())
            WHERE organization_id = fixture_organization_id;
            IF authorization_allows_project(fixture_organization_id, fixture_project_id, fixture_actor_id, 'release_gate_manage')
                IS DISTINCT FROM (fixture_role = 'admin') THEN
                RAISE EXCEPTION '0088 release_gate_manage must allow only Admins in both enforcement modes';
            END IF;
            IF authorization_allows_project(fixture_organization_id, fixture_project_id, fixture_actor_id, 'release_gate_manage')
                IS DISTINCT FROM authorization_allows_project_before_local_sessions(fixture_organization_id, fixture_project_id, fixture_actor_id, 'release_gate_manage') THEN
                RAISE EXCEPTION '0101 wrapper changed release gate policy for eligible Basic actors';
            END IF;
        END LOOP;
    END LOOP;
END $$;
ROLLBACK;
