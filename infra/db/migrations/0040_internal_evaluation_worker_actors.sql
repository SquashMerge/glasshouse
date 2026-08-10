CREATE OR REPLACE FUNCTION provision_internal_evaluation_worker_actor(
    target_organization_id UUID
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    internal_provider_namespace CONSTANT TEXT := 'internal:evaluation-worker:v1';
    expected_actor_id UUID := durable_actor_id(
        internal_provider_namespace,
        target_organization_id::text
    );
BEGIN
    IF EXISTS (
        SELECT 1
        FROM actor_identities identity
        WHERE identity.provider_namespace = internal_provider_namespace
          AND identity.canonical_subject = target_organization_id::text
          AND (
              identity.actor_id <> expected_actor_id
              OR identity.organization_id <> target_organization_id
          )
    ) THEN
        RAISE EXCEPTION 'internal evaluation worker identity does not match organization';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM actors actor
        WHERE actor.id = expected_actor_id
          AND NOT EXISTS (
              SELECT 1
              FROM actor_identities identity
              WHERE identity.actor_id = expected_actor_id
                AND identity.organization_id = target_organization_id
                AND identity.provider_namespace = internal_provider_namespace
                AND identity.canonical_subject = target_organization_id::text
          )
    ) THEN
        RAISE EXCEPTION 'internal evaluation worker actor ID is already linked or orphaned';
    END IF;

    INSERT INTO actors (id)
    VALUES (expected_actor_id)
    ON CONFLICT DO NOTHING;

    INSERT INTO actor_identities (
        actor_id,
        organization_id,
        provider_namespace,
        canonical_subject
    ) VALUES (
        expected_actor_id,
        target_organization_id,
        internal_provider_namespace,
        target_organization_id::text
    ) ON CONFLICT DO NOTHING;

    IF NOT EXISTS (
        SELECT 1
        FROM actor_identities identity
        WHERE identity.actor_id = expected_actor_id
          AND identity.organization_id = target_organization_id
          AND identity.provider_namespace = internal_provider_namespace
          AND identity.canonical_subject = target_organization_id::text
    ) THEN
        RAISE EXCEPTION 'internal evaluation worker actor identity could not be provisioned';
    END IF;
END
$$;

SELECT provision_internal_evaluation_worker_actor(organization.id)
FROM organizations organization;

CREATE OR REPLACE FUNCTION provision_internal_evaluation_worker_actor_on_organization_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM provision_internal_evaluation_worker_actor(NEW.id);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS organizations_internal_evaluation_worker_actor ON organizations;
CREATE TRIGGER organizations_internal_evaluation_worker_actor
AFTER INSERT ON organizations
FOR EACH ROW
EXECUTE FUNCTION provision_internal_evaluation_worker_actor_on_organization_insert();
