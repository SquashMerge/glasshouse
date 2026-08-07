DO $$
DECLARE
    archived_organization_id UUID := '00330000-0000-4000-8000-000000000001';
    archived_project_id UUID := '00330000-0000-4000-8000-000000000002';
    active_organization_id UUID := '00330000-0000-4000-8000-000000000005';
    preferred_default_project_id UUID := '00330000-0000-4000-8000-000000000007';
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM organizations
        WHERE id = active_organization_id
          AND default_project_id = preferred_default_project_id
    ) THEN
        RAISE EXCEPTION '0033 did not deterministically select the same-organization active default project';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM organizations organization
        JOIN projects project
          ON project.id = organization.default_project_id
         AND project.organization_id = organization.id
        WHERE organization.id = archived_organization_id
          AND project.status = 'active'
          AND project.name = 'Default Project'
          AND project.slug = 'default-00330000000040008000000000000001-3'
    ) THEN
        RAISE EXCEPTION '0033 did not provision a same-organization active default project';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE id = archived_project_id
          AND status = 'archived'
    ) THEN
        RAISE EXCEPTION '0033 reactivated archived project data';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM projects
        WHERE organization_id = archived_organization_id
          AND slug IN (
              'default',
              'default-00330000000040008000000000000001',
              'default-00330000000040008000000000000001-2'
          )
          AND status <> 'archived'
    ) THEN
        RAISE EXCEPTION '0033 changed archived collision data';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM organizations organization
        JOIN project_memberships membership
          ON membership.project_id = organization.default_project_id
         AND membership.organization_id = organization.id
        WHERE organization.id = archived_organization_id
          AND membership.actor_subject = 'archived-only-owner'
          AND membership.role = 'manager'
    ) THEN
        RAISE EXCEPTION '0033 did not grant the existing organization owner a same-organization default manager membership';
    END IF;
END
$$;
