DO $$
DECLARE
    existing_organization_id CONSTANT UUID := '88888888-8888-4888-8888-888888888888';
    future_organization_id CONSTANT UUID := '77777777-7777-4777-8777-777777777777';
    future_project_id CONSTANT UUID := '77777777-7777-4777-8777-777777777776';
    internal_provider_namespace CONSTANT TEXT := 'internal:evaluation-worker:v1';
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM actor_identities identity
        WHERE identity.actor_id = durable_actor_id(internal_provider_namespace, existing_organization_id::text)
          AND identity.organization_id = existing_organization_id
          AND identity.provider_namespace = internal_provider_namespace
          AND identity.canonical_subject = existing_organization_id::text
    ) THEN
        RAISE EXCEPTION 'existing organization did not receive its internal evaluation actor';
    END IF;

    ALTER TABLE organizations ALTER COLUMN default_project_id DROP NOT NULL;
    INSERT INTO organizations (id, name, slug)
    VALUES (future_organization_id, 'Future Internal Worker', 'future-internal-worker');
    INSERT INTO projects (id, name, slug, organization_id)
    VALUES (future_project_id, 'Future Internal Worker Project', 'future-internal-worker-project', future_organization_id);
    UPDATE organizations
    SET default_project_id = future_project_id
    WHERE id = future_organization_id;
    ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;

    IF NOT EXISTS (
        SELECT 1
        FROM actor_identities identity
        WHERE identity.actor_id = durable_actor_id(internal_provider_namespace, future_organization_id::text)
          AND identity.organization_id = future_organization_id
          AND identity.provider_namespace = internal_provider_namespace
          AND identity.canonical_subject = future_organization_id::text
    ) THEN
        RAISE EXCEPTION 'organization insert trigger did not provision its internal evaluation actor';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM organization_memberships membership
        WHERE membership.organization_id IN (existing_organization_id, future_organization_id)
          AND membership.actor_subject = internal_provider_namespace
    ) OR EXISTS (
        SELECT 1
        FROM project_memberships membership
        JOIN projects project ON project.id = membership.project_id
        WHERE project.organization_id IN (existing_organization_id, future_organization_id)
          AND membership.actor_subject = internal_provider_namespace
    ) THEN
        RAISE EXCEPTION 'internal evaluation actor received a legacy membership';
    END IF;
END
$$;
