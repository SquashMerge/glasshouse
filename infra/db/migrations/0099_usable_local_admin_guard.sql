CREATE OR REPLACE FUNCTION organization_actor_is_usable_admin(
    target_organization_id UUID,
    target_actor_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM organization_actor_roles role
        JOIN actor_identities identity
          ON identity.organization_id = role.organization_id
         AND identity.actor_id = role.actor_id
        WHERE role.organization_id = target_organization_id
          AND role.actor_id = target_actor_id
          AND role.role = 'admin'
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
$$;

CREATE OR REPLACE FUNCTION prevent_final_admin_role_removal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.role = 'admin' AND (TG_OP = 'DELETE' OR NEW.role <> 'admin') THEN
        -- Preserve the existing membership/project/audit lock order and the
        -- organization fence that serializes final-Admin role removals.
        PERFORM pg_advisory_xact_lock(hashtextextended(OLD.organization_id::text, 51));
        IF NOT EXISTS (
            SELECT 1
            FROM organization_actor_roles role
            WHERE role.organization_id = OLD.organization_id
              AND role.actor_id <> OLD.actor_id
              AND organization_actor_is_usable_admin(role.organization_id, role.actor_id)
        ) THEN
            RAISE EXCEPTION 'cannot remove or demote the final organization Admin';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;
