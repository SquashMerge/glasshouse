BEGIN;
DO $$
DECLARE
    organization_id UUID := gen_random_uuid();
    local_actor_id UUID := gen_random_uuid();
    basic_actor_id UUID := gen_random_uuid();
BEGIN
    WITH organization AS (
        INSERT INTO organizations (id, name, slug, default_project_id)
        VALUES (organization_id, 'Usable Admin migration test', organization_id::text, gen_random_uuid())
        RETURNING id, default_project_id
    )
    INSERT INTO projects (id, organization_id, name, slug)
    SELECT default_project_id, id, 'Default', 'default' FROM organization;
    INSERT INTO actors (id) VALUES (local_actor_id), (basic_actor_id);
    INSERT INTO actor_identities (organization_id, actor_id, provider_namespace, canonical_subject)
    VALUES (organization_id, local_actor_id, 'local:v1', organization_id::text || ':pending'),
        (organization_id, basic_actor_id, 'basic:v1', basic_actor_id::text);
    INSERT INTO organization_actor_roles (organization_id, actor_id, role)
    VALUES (organization_id, local_actor_id, 'admin'), (organization_id, basic_actor_id, 'admin');

    IF organization_actor_is_usable_admin(organization_id, local_actor_id) THEN
        RAISE EXCEPTION 'local identity without credentials counted as usable Admin';
    END IF;
    INSERT INTO local_credentials (organization_id, actor_id, username)
    VALUES (organization_id, local_actor_id, 'pending');
    IF organization_actor_is_usable_admin(organization_id, local_actor_id) THEN
        RAISE EXCEPTION 'passwordless local Admin counted as usable';
    END IF;
    IF NOT organization_actor_is_usable_admin(organization_id, basic_actor_id) THEN
        RAISE EXCEPTION 'legacy Basic Admin no longer counted as usable';
    END IF;
    IF organization_actor_is_usable_admin(gen_random_uuid(), basic_actor_id) THEN
        RAISE EXCEPTION 'usable Admin predicate crossed organization scope';
    END IF;
    UPDATE organization_actor_roles SET role = 'user'
    WHERE actor_id = local_actor_id;
    IF organization_actor_is_usable_admin(organization_id, local_actor_id) THEN
        RAISE EXCEPTION 'non-Admin counted as usable Admin';
    END IF;
END;
$$;
ROLLBACK;
