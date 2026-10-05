DO $$
DECLARE
    organization_id UUID := '00000000-0000-4000-8000-000000000001';
    project_id UUID;
    reader_id UUID := durable_actor_id('basic:v1', 'migration-role-reader');
    disabled_local_id UUID := durable_actor_id('local:v1', 'migration-role-disabled-local');
    disabled_local_subject TEXT;
    assigned_role TEXT;
BEGIN
    SELECT default_project_id INTO project_id FROM organizations WHERE id = organization_id;

    INSERT INTO actors (id) VALUES (reader_id), (disabled_local_id) ON CONFLICT DO NOTHING;
    INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
    VALUES (reader_id, organization_id, 'basic:v1', 'migration-role-reader')
    ON CONFLICT DO NOTHING;
    INSERT INTO organization_actor_roles (organization_id, actor_id, role)
    VALUES (organization_id, reader_id, 'read_only')
    ON CONFLICT (organization_id, actor_id) DO UPDATE SET role = EXCLUDED.role;

    IF EXISTS (SELECT 1 FROM project_actor_grants) THEN
        RAISE EXCEPTION 'legacy project grants remain after organization-role migration';
    END IF;
    SELECT r.role INTO assigned_role FROM organization_actor_roles r
    WHERE r.organization_id = organization_id AND r.actor_id = reader_id;
    IF assigned_role IS DISTINCT FROM 'read_only' THEN
        RAISE EXCEPTION 'organization Read-only role was not retained';
    END IF;
    IF NOT authorization_allows_project(organization_id, project_id, reader_id, 'product_read')
        OR authorization_allows_project(organization_id, project_id, reader_id, 'product_write') THEN
        RAISE EXCEPTION 'organization Read-only role did not control project access';
    END IF;

    disabled_local_subject := organization_id::text || ':migration-role-disabled-local';
    INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
    VALUES (disabled_local_id, organization_id, 'local:v1', disabled_local_subject)
    ON CONFLICT DO NOTHING;
    INSERT INTO local_credentials (organization_id, actor_id, username, enabled)
    VALUES (organization_id, disabled_local_id, 'migration-role-disabled-local', false)
    ON CONFLICT (organization_id, username) DO UPDATE SET enabled = false;
    INSERT INTO organization_actor_roles (organization_id, actor_id, role)
    VALUES (organization_id, disabled_local_id, 'user')
    ON CONFLICT (organization_id, actor_id) DO UPDATE SET role = EXCLUDED.role;

    IF authorization_allows_project(organization_id, project_id, disabled_local_id, 'product_read') THEN
        RAISE EXCEPTION 'disabled local actor retained SQL project authorization';
    END IF;
END;
$$;
