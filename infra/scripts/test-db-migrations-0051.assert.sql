DO $$
DECLARE
    fixture_organization_id UUID := '51000000-0000-4000-8000-000000000001';
    fixture_owner_id UUID := '51000000-0000-4000-8000-000000000101';
    fixture_reader_id UUID := '51000000-0000-4000-8000-000000000102';
    fixture_other_id UUID := '51000000-0000-4000-8000-000000000103';
    fixture_worker_id UUID := durable_actor_id(
        'internal:evaluation-worker:v1',
        fixture_organization_id::text
    );
    fixture_project_id UUID := '51000000-0000-4000-8000-000000000011';
BEGIN
    IF (
        SELECT count(*)
        FROM organizations AS organization
        JOIN projects AS project
            ON project.id = organization.default_project_id
            AND project.organization_id = organization.id
        WHERE (organization.id, organization.default_project_id) IN (
            ('51000000-0000-4000-8000-000000000001'::uuid, '51000000-0000-4000-8000-000000000010'::uuid),
            ('51000000-0000-4000-8000-000000000002'::uuid, '51000000-0000-4000-8000-000000000020'::uuid)
        )
    ) <> 2 THEN
        RAISE EXCEPTION '0051 fixture default projects are not scoped to their organizations';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'organizations'
          AND column_name = 'default_project_id'
          AND is_nullable = 'NO'
    ) THEN
        RAISE EXCEPTION '0051 fixture did not restore organizations.default_project_id NOT NULL';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM organization_actor_roles
        WHERE organization_id = fixture_organization_id AND actor_id = fixture_owner_id AND role = 'admin'
    ) OR NOT EXISTS (
        SELECT 1 FROM project_actor_grants
        WHERE project_id = fixture_project_id AND actor_id = fixture_reader_id AND role = 'read_only'
    ) THEN
        RAISE EXCEPTION '0051 did not backfill durable organization roles and project grants';
    END IF;

    IF NOT authorization_allows_project(
        fixture_organization_id,
        fixture_project_id,
        fixture_owner_id,
        'product_write'
    ) THEN
        RAISE EXCEPTION '0051 did not authorize the durable Admin role';
    END IF;
    IF NOT authorization_allows_project(
        fixture_organization_id,
        fixture_project_id,
        fixture_worker_id,
        'execute'
    ) THEN
        RAISE EXCEPTION '0051 removed internal evaluation worker authorization';
    END IF;

    UPDATE authorization_policy_settings
    SET strict_enforcement = true, enabled_at = now()
    WHERE organization_id = fixture_organization_id;
    IF NOT authorization_allows_project(
        fixture_organization_id,
        fixture_project_id,
        fixture_reader_id,
        'product_read'
    ) OR authorization_allows_project(
        fixture_organization_id,
        fixture_project_id,
        fixture_reader_id,
        'product_write'
    ) THEN
        RAISE EXCEPTION '0051 did not enforce the durable Read-only project grant';
    END IF;

    UPDATE project_actor_grants
    SET role = 'user'
    WHERE project_id = fixture_project_id AND actor_id = fixture_reader_id;
    BEGIN
        UPDATE organization_actor_roles
        SET role = 'read_only'
        WHERE organization_id = fixture_organization_id AND actor_id = fixture_reader_id;
        RAISE EXCEPTION '0051 accepted a Read-only role with a User project grant';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'organization role cannot be Read-only while User project grants exist' THEN RAISE; END IF;
    END;
    UPDATE project_actor_grants
    SET role = 'read_only'
    WHERE project_id = fixture_project_id AND actor_id = fixture_reader_id;
    UPDATE organization_actor_roles
    SET role = 'read_only'
    WHERE organization_id = fixture_organization_id AND actor_id = fixture_reader_id;
    BEGIN
        UPDATE project_actor_grants
        SET role = 'user'
        WHERE project_id = fixture_project_id AND actor_id = fixture_reader_id;
        RAISE EXCEPTION '0051 accepted a User project grant for a Read-only actor';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'project grant exceeds the target organization role' THEN RAISE; END IF;
    END;

    BEGIN
        INSERT INTO project_actor_grants (project_id, organization_id, actor_id, role)
        VALUES (fixture_project_id, fixture_organization_id, fixture_other_id, 'read_only');
        RAISE EXCEPTION '0051 accepted a cross-organization project grant';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'project grant actor identity is outside the organization' THEN RAISE; END IF;
    END;

    BEGIN
        INSERT INTO project_actor_grants (project_id, organization_id, actor_id, role)
        VALUES (fixture_project_id, fixture_organization_id, fixture_worker_id, 'read_only');
        RAISE EXCEPTION '0051 accepted a project grant without an organization role';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'project grants require a non-Admin organization role' THEN RAISE; END IF;
    END;

    BEGIN
        UPDATE organization_actor_roles
        SET role = 'user'
        WHERE organization_id = fixture_organization_id AND actor_id = fixture_owner_id;
        RAISE EXCEPTION '0051 accepted final Admin demotion';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'cannot remove or demote the final organization Admin' THEN RAISE; END IF;
    END;

    INSERT INTO admin_access_audit_events (
        organization_id, project_id, actor_id, target_actor_id, action, correlation_id
    ) VALUES (
        fixture_organization_id, fixture_project_id, fixture_owner_id, fixture_reader_id, 'project_grant_set', gen_random_uuid()
    );
    PERFORM audit_admin_access_event(
        fixture_organization_id,
        fixture_project_id,
        fixture_owner_id,
        fixture_reader_id,
        'project_grant_set'
    );
    PERFORM audit_admin_access_event(
        fixture_organization_id,
        NULL,
        fixture_owner_id,
        fixture_owner_id,
        'bootstrap_owner_granted'
    );
    IF NOT EXISTS (
        SELECT 1 FROM admin_access_audit_events
        WHERE organization_id = fixture_organization_id
          AND project_id = fixture_project_id
          AND actor_id = fixture_owner_id
          AND target_actor_id = fixture_reader_id
          AND action = 'project_grant_set'
    ) THEN
        RAISE EXCEPTION '0051 did not retain the project-scoped admin audit event';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM admin_access_audit_events
        WHERE organization_id = fixture_organization_id
          AND project_id IS NULL
          AND actor_id = fixture_owner_id
          AND target_actor_id = fixture_owner_id
          AND action = 'bootstrap_owner_granted'
    ) THEN
        RAISE EXCEPTION '0051 did not record the organization-scoped admin audit event';
    END IF;
    BEGIN
        DELETE FROM admin_access_audit_events WHERE organization_id = fixture_organization_id;
        RAISE EXCEPTION '0051 accepted audit deletion';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;
END;
$$;
