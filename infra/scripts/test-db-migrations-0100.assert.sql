BEGIN;
DO $$
DECLARE
    target_organization_id UUID;
    basic_actor_id UUID;
    local_actor_id UUID;
    account_status TEXT;
    unlink_blocked BOOLEAN;
    before_state JSONB;
    after_state JSONB;
BEGIN
    FOREACH account_status IN ARRAY ARRAY['pending', 'revoked', 'expired', 'disabled', 'usable', 'non_admin']
    LOOP
        target_organization_id := gen_random_uuid();
        basic_actor_id := gen_random_uuid();
        local_actor_id := gen_random_uuid();
        WITH organization AS (
            INSERT INTO organizations (id, name, slug, default_project_id)
            VALUES (target_organization_id, 'Admin unlink migration test', target_organization_id::text, gen_random_uuid())
            RETURNING id, default_project_id
        )
        INSERT INTO projects (id, organization_id, name, slug)
        SELECT default_project_id, id, 'Default', 'default' FROM organization;
        INSERT INTO actors (id) VALUES (basic_actor_id), (local_actor_id);
        INSERT INTO actor_identities (organization_id, actor_id, provider_namespace, canonical_subject)
        VALUES (target_organization_id, basic_actor_id, 'basic:v1', basic_actor_id::text),
            (target_organization_id, local_actor_id, 'local:v1', target_organization_id::text || ':replacement');
        INSERT INTO organization_actor_roles (organization_id, actor_id, role)
        VALUES (target_organization_id, basic_actor_id, 'admin'),
            (target_organization_id, local_actor_id, CASE WHEN account_status = 'non_admin' THEN 'user' ELSE 'admin' END);
        INSERT INTO local_credentials (organization_id, actor_id, username)
        VALUES (target_organization_id, local_actor_id, 'replacement');
        INSERT INTO local_account_enrollments (organization_id, actor_id, provisioned_by, kind, token_digest, created_at, expires_at, revoked_at)
        VALUES (target_organization_id, local_actor_id, local_actor_id, 'first_use',
            decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'),
            CASE WHEN account_status = 'expired' THEN now() - interval '8 days' ELSE now() END,
            CASE WHEN account_status = 'expired' THEN now() - interval '1 day' ELSE now() + interval '7 days' END,
            CASE WHEN account_status = 'revoked' THEN now() END);
        IF account_status IN ('disabled', 'usable', 'non_admin') THEN
            UPDATE local_credentials SET password_hash = '$argon2id$v=19$m=65536,t=3,p=1$YWJj$ZGVm',
                password_algorithm = 'argon2id', password_version = 1, enabled = account_status <> 'disabled'
            WHERE organization_id = target_organization_id AND actor_id = local_actor_id;
            UPDATE local_account_enrollments SET consumed_at = now()
            WHERE organization_id = target_organization_id AND actor_id = local_actor_id;
        END IF;
        SELECT jsonb_build_object(
            'roles', (SELECT jsonb_agg(to_jsonb(role) ORDER BY actor_id) FROM organization_actor_roles role WHERE organization_id = target_organization_id),
            'credentials', (SELECT jsonb_agg(jsonb_build_array(actor_id, enabled, password_hash IS NOT NULL, updated_at) ORDER BY actor_id) FROM local_credentials WHERE organization_id = target_organization_id),
            'enrollments', (SELECT jsonb_agg(jsonb_build_array(id, consumed_at, revoked_at) ORDER BY id) FROM local_account_enrollments WHERE organization_id = target_organization_id),
            'actors', (SELECT count(*) FROM actors)
        ) INTO before_state;
        unlink_blocked := false;
        BEGIN
            DELETE FROM actor_identities
            WHERE organization_id = target_organization_id AND actor_id = basic_actor_id AND provider_namespace = 'basic:v1';
        EXCEPTION WHEN raise_exception THEN
            IF SQLERRM <> 'cannot unlink the final organization Admin identity' THEN
                RAISE;
            END IF;
            unlink_blocked := true;
        END;
        IF unlink_blocked <> (account_status <> 'usable') THEN
            RAISE EXCEPTION 'unexpected Basic Admin unlink result for %', account_status;
        END IF;
        IF EXISTS (
            SELECT 1 FROM actor_identities
            WHERE organization_id = target_organization_id AND actor_id = basic_actor_id AND provider_namespace = 'basic:v1'
        ) <> unlink_blocked THEN
            RAISE EXCEPTION 'Basic identity deletion did not match unlink result for %', account_status;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM actor_identities
            WHERE organization_id = target_organization_id AND actor_id = local_actor_id AND provider_namespace = 'local:v1'
        ) THEN
            RAISE EXCEPTION 'unlink removed the replacement identity for %', account_status;
        END IF;
        SELECT jsonb_build_object(
            'roles', (SELECT jsonb_agg(to_jsonb(role) ORDER BY actor_id) FROM organization_actor_roles role WHERE organization_id = target_organization_id),
            'credentials', (SELECT jsonb_agg(jsonb_build_array(actor_id, enabled, password_hash IS NOT NULL, updated_at) ORDER BY actor_id) FROM local_credentials WHERE organization_id = target_organization_id),
            'enrollments', (SELECT jsonb_agg(jsonb_build_array(id, consumed_at, revoked_at) ORDER BY id) FROM local_account_enrollments WHERE organization_id = target_organization_id),
            'actors', (SELECT count(*) FROM actors)
        ) INTO after_state;
        IF before_state IS DISTINCT FROM after_state THEN
            RAISE EXCEPTION 'unlink changed role/account records for %', account_status;
        END IF;
    END LOOP;
END;
$$;
ROLLBACK;
