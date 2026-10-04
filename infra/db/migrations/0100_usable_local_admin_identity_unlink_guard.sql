CREATE OR REPLACE FUNCTION prevent_final_admin_identity_unlink()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM organization_actor_roles role
        WHERE role.organization_id = OLD.organization_id
          AND role.actor_id = OLD.actor_id
          AND role.role = 'admin'
    ) THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(OLD.organization_id::text, 51));
        IF NOT EXISTS (
            SELECT 1
            FROM organization_actor_roles role
            WHERE role.organization_id = OLD.organization_id
              AND role.role = 'admin'
              AND EXISTS (
                  SELECT 1
                  FROM actor_identities identity
                  WHERE identity.organization_id = role.organization_id
                    AND identity.actor_id = role.actor_id
                    AND NOT (
                        identity.actor_id = OLD.actor_id
                        AND identity.provider_namespace = OLD.provider_namespace
                    )
                    -- Match 0099's usable-Admin predicate on the remaining
                    -- identity; the actor-wide helper can still see OLD here.
                    AND (
                        identity.provider_namespace <> 'local:v1'
                        OR EXISTS (
                            SELECT 1
                            FROM local_credentials credential
                            WHERE credential.organization_id = identity.organization_id
                              AND credential.actor_id = identity.actor_id
                              AND credential.enabled
                              AND credential.password_hash IS NOT NULL
                        )
                    )
              )
        ) THEN
            RAISE EXCEPTION 'cannot unlink the final organization Admin identity';
        END IF;
    END IF;
    RETURN OLD;
END;
$$;
