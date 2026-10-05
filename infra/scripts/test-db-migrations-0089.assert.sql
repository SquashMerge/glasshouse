BEGIN;
DO $$
DECLARE
    fixture_organization_id CONSTANT UUID := '00000000-0000-4000-8000-000000000001';
    fixture_project_id CONSTANT UUID := '89000000-0000-4000-8000-000000000001';
    fixture_user_id CONSTANT UUID := '89000000-0000-4000-8000-000000000002';
    fixture_reader_id CONSTANT UUID := '89000000-0000-4000-8000-000000000003';
    policy_function TEXT;
BEGIN
    INSERT INTO projects (id, organization_id, name, slug, status)
    VALUES (
        fixture_project_id,
        fixture_organization_id,
        'Strict Curation Authorization Fixture',
        'strict-curation-authorization-fixture',
        'active'
    ) ON CONFLICT (id) DO NOTHING;

    INSERT INTO actors (id) VALUES (fixture_user_id), (fixture_reader_id)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
    VALUES
        (fixture_user_id, fixture_organization_id, 'basic:v1', 'strict-curation-user'),
        (fixture_reader_id, fixture_organization_id, 'basic:v1', 'strict-curation-reader')
    ON CONFLICT DO NOTHING;
    INSERT INTO organization_actor_roles (organization_id, actor_id, role)
    VALUES
        (fixture_organization_id, fixture_user_id, 'user'),
        (fixture_organization_id, fixture_reader_id, 'read_only')
    ON CONFLICT (organization_id, actor_id) DO UPDATE SET role = EXCLUDED.role;
    UPDATE authorization_policy_settings
    SET strict_enforcement = true, enabled_at = now()
    WHERE organization_id = fixture_organization_id;

    IF NOT authorization_allows_project(
        fixture_organization_id,
        fixture_project_id,
        fixture_user_id,
        'curation_write'
    ) THEN
        RAISE EXCEPTION '0089 did not authorize strict Users to curate';
    END IF;
    IF authorization_allows_project(
        fixture_organization_id,
        fixture_project_id,
        fixture_reader_id,
        'curation_write'
    ) THEN
        RAISE EXCEPTION '0089 allowed strict Read-only actors to curate';
    END IF;

    policy_function := pg_get_functiondef(
        'public.authorization_allows_project_before_local_sessions(uuid,uuid,uuid,text)'::regprocedure
    );
    IF policy_function !~ E'WHEN\\s+effective_role\\s+=\\s+''user''\\s+THEN\\s+operation\\s+IN\\s*\\([^)]*''curation_write''' THEN
        RAISE EXCEPTION '0089 strict User curation parity guard is missing';
    END IF;
END
$$;
ROLLBACK;
