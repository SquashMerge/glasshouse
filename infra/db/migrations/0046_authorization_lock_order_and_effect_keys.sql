-- PostgreSQL locks the target membership row before a BEFORE ROW trigger runs.
-- Authorization and membership-management transactions therefore take actor
-- memberships before Project rows. Revocation inherently has the same order:
-- target membership row, then the affected Project row(s).
CREATE OR REPLACE FUNCTION fence_authorization_membership_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id UUID;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.role = NEW.role THEN
        RETURN NEW;
    END IF;

    -- Promotions do not revoke an existing authorization epoch.
    IF TG_OP = 'UPDATE' AND (
        (TG_TABLE_NAME = 'organization_memberships' AND NOT (OLD.role = 'owner' AND NEW.role = 'member'))
        OR (TG_TABLE_NAME = 'project_memberships' AND NOT (OLD.role = 'manager' AND NEW.role = 'member'))
    ) THEN
        RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = 'organization_memberships' THEN
        FOR target_project_id IN
            SELECT id
            FROM projects
            WHERE organization_id = OLD.organization_id
            ORDER BY id
            FOR UPDATE
        LOOP
            UPDATE projects
            SET authorization_epoch = authorization_epoch + 1
            WHERE id = target_project_id;
            PERFORM cancel_project_execution_admissions(
                OLD.organization_id,
                target_project_id,
                OLD.actor_subject
            );
        END LOOP;
    ELSIF TG_TABLE_NAME = 'project_memberships' THEN
        SELECT id INTO target_project_id
        FROM projects
        WHERE id = OLD.project_id
          AND organization_id = OLD.organization_id
        FOR UPDATE;
        IF target_project_id IS NOT NULL THEN
            UPDATE projects
            SET authorization_epoch = authorization_epoch + 1
            WHERE id = target_project_id;
            PERFORM cancel_project_execution_admissions(
                OLD.organization_id,
                target_project_id,
                OLD.actor_subject
            );
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION fence_authorization_membership_revocation() IS
    'Global authorization order is membership then Project: PostgreSQL locks the target membership row before this trigger locks affected Projects.';

ALTER TABLE execution_admission_claims
    ADD COLUMN IF NOT EXISTS effect_key TEXT;

-- Existing claims predate caller-stable keys. Their immutable UUIDs preserve
-- their individual identity without merging previously distinct effects.
UPDATE execution_admission_claims
SET effect_key = id::text
WHERE effect_key IS NULL;

ALTER TABLE execution_admission_claims
    ALTER COLUMN effect_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS execution_admission_claims_effect_key_unique
    ON execution_admission_claims (admission_id, effect, effect_key);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'execution_admission_claims'::regclass
          AND conname = 'execution_admission_claims_effect_key_nonempty'
    ) THEN
        ALTER TABLE execution_admission_claims
            ADD CONSTRAINT execution_admission_claims_effect_key_nonempty
            CHECK (length(effect_key) > 0);
    END IF;
END
$$;
