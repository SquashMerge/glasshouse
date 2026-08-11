-- Membership revocation must serialize with every project authorization decision.
-- Authorization paths lock project, then actor memberships; revocations take the
-- same project fence before changing either membership row.
CREATE OR REPLACE FUNCTION fence_authorization_membership_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_TABLE_NAME = 'organization_memberships' THEN
        PERFORM 1
        FROM projects
        WHERE organization_id = OLD.organization_id
        ORDER BY id
        FOR UPDATE;
    ELSIF TG_TABLE_NAME = 'project_memberships' THEN
        PERFORM 1
        FROM projects
        WHERE id = OLD.project_id
          AND organization_id = OLD.organization_id
        FOR UPDATE;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS authorization_organization_membership_revocation_fence
    ON organization_memberships;
CREATE TRIGGER authorization_organization_membership_revocation_fence
BEFORE DELETE OR UPDATE OF role ON organization_memberships
FOR EACH ROW EXECUTE FUNCTION fence_authorization_membership_revocation();

DROP TRIGGER IF EXISTS authorization_project_membership_revocation_fence
    ON project_memberships;
CREATE TRIGGER authorization_project_membership_revocation_fence
BEFORE DELETE OR UPDATE OF role ON project_memberships
FOR EACH ROW EXECUTE FUNCTION fence_authorization_membership_revocation();
