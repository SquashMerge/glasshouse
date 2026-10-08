-- Every Project receives this immutable, approved baseline. Projects with an
-- approved policy are left untouched; an existing draft is retained and the
-- baseline is appended at the next version when necessary.
CREATE OR REPLACE FUNCTION ensure_default_governance_policy(
    target_organization_id UUID,
    target_project_id UUID
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    baseline_retention JSONB := jsonb_build_object(
        'traces', 30,
        'datasets', 90,
        'feedback', 90
    );
    baseline_redaction JSONB := jsonb_build_object('mode', 'none', 'keys', '[]'::jsonb);
    baseline_hash TEXT := encode(
        digest(
            '{"retention":{"traces":30,"datasets":90,"feedback":90},"redaction":{"mode":"none","keys":[]}}',
            'sha256'
        ),
        'hex'
    );
    baseline_actor TEXT := 'system:governance-defaults';
    target_policy_id UUID;
    target_version_id UUID;
    approved_version_id UUID;
    created_version BOOLEAN := false;
BEGIN
    PERFORM 1
    FROM organization_memberships
    WHERE organization_id = target_organization_id
    ORDER BY actor_subject
    FOR UPDATE;

    PERFORM 1
    FROM organization_actor_roles
    WHERE organization_id = target_organization_id
    ORDER BY actor_id
    FOR UPDATE;

    PERFORM 1
    FROM project_memberships
    WHERE organization_id = target_organization_id
      AND project_id = target_project_id
    ORDER BY actor_subject
    FOR UPDATE;

    PERFORM 1
    FROM projects
    WHERE id = target_project_id
      AND organization_id = target_organization_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    PERFORM lock_project_audit_provenance(target_project_id);

    IF EXISTS (
        SELECT 1
        FROM governance_policy_approvals approval
        JOIN governance_policy_versions policy_version
          ON policy_version.id = approval.policy_version_id
        JOIN governance_policies policy ON policy.id = policy_version.policy_id
        WHERE policy.organization_id = target_organization_id
          AND policy.project_id = target_project_id
    ) THEN
        RETURN;
    END IF;

    INSERT INTO governance_policies (organization_id, project_id)
    VALUES (target_organization_id, target_project_id)
    ON CONFLICT (project_id) DO NOTHING;

    SELECT id INTO target_policy_id
    FROM governance_policies
    WHERE organization_id = target_organization_id
      AND project_id = target_project_id
    FOR UPDATE;

    SELECT id INTO target_version_id
    FROM governance_policy_versions
    WHERE policy_id = target_policy_id
      AND content_hash = baseline_hash
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO governance_policy_versions (
            policy_id,
            organization_id,
            project_id,
            version,
            retention,
            redaction,
            content_hash,
            created_by
        )
        SELECT
            target_policy_id,
            target_organization_id,
            target_project_id,
            COALESCE(max(version) + 1, 1),
            baseline_retention,
            baseline_redaction,
            baseline_hash,
            baseline_actor
        FROM governance_policy_versions
        WHERE policy_id = target_policy_id
        RETURNING id INTO target_version_id;
        created_version := true;
    END IF;

    IF created_version THEN
        INSERT INTO governance_audit_events (
            organization_id,
            project_id,
            policy_version_id,
            actor_subject,
            event_type
        ) VALUES (
            target_organization_id,
            target_project_id,
            target_version_id,
            baseline_actor,
            'policy_created'
        );
    END IF;

    INSERT INTO governance_policy_approvals (
        policy_version_id,
        organization_id,
        project_id,
        actor_subject
    ) VALUES (
        target_version_id,
        target_organization_id,
        target_project_id,
        baseline_actor
    )
    ON CONFLICT (policy_version_id) DO NOTHING
    RETURNING policy_version_id INTO approved_version_id;

    IF approved_version_id IS NOT NULL THEN
        INSERT INTO governance_audit_events (
            organization_id,
            project_id,
            policy_version_id,
            actor_subject,
            event_type
        ) VALUES (
            target_organization_id,
            target_project_id,
            approved_version_id,
            baseline_actor,
            'policy_approved'
        );
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION provision_default_governance_policy_for_project()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM ensure_default_governance_policy(NEW.organization_id, NEW.id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS projects_default_governance_policy ON projects;
CREATE TRIGGER projects_default_governance_policy
AFTER INSERT ON projects
FOR EACH ROW EXECUTE FUNCTION provision_default_governance_policy_for_project();

DO $$
DECLARE
    project_record RECORD;
BEGIN
    FOR project_record IN
        SELECT id, organization_id
        FROM projects
        ORDER BY id
    LOOP
        PERFORM ensure_default_governance_policy(
            project_record.organization_id,
            project_record.id
        );
    END LOOP;
END;
$$;
