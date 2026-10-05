DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM local_upgrade_continuity
        WHERE name = 'grants' AND jsonb_array_length(rows) > 0
    ) THEN
        RAISE EXCEPTION 'legacy-grant upgrade fixture must contain populated rows';
    END IF;
    IF EXISTS (SELECT 1 FROM project_actor_grants) THEN
        RAISE EXCEPTION 'organization-role migration retained active legacy project grants';
    END IF;
    IF EXISTS (
        WITH current_rows AS (
            SELECT 'actors' AS name, jsonb_agg(to_jsonb(t) ORDER BY id) AS rows FROM actors t
            UNION ALL SELECT 'identities', jsonb_agg(to_jsonb(t) ORDER BY provider_namespace, canonical_subject) FROM actor_identities t
            UNION ALL SELECT 'roles', jsonb_agg(to_jsonb(t) ORDER BY organization_id, actor_id) FROM organization_actor_roles t
            UNION ALL SELECT 'organization_memberships', jsonb_agg(to_jsonb(t) ORDER BY organization_id, actor_subject) FROM organization_memberships t
            UNION ALL SELECT 'project_memberships', jsonb_agg(to_jsonb(t) ORDER BY project_id, actor_subject) FROM project_memberships t
            UNION ALL SELECT 'admin_audit', jsonb_agg(to_jsonb(t) ORDER BY id) FROM admin_access_audit_events t
            UNION ALL SELECT 'project_audit', jsonb_agg(to_jsonb(t) ORDER BY id) FROM project_authorization_audit_events t
        ) SELECT 1 FROM current_rows current JOIN local_upgrade_continuity old USING (name) WHERE current.rows IS DISTINCT FROM old.rows
    ) THEN
        RAISE EXCEPTION 'local migration changed legacy identity, role, membership, or audit continuity';
    END IF;
END;
$$;
DROP TABLE local_upgrade_continuity;
