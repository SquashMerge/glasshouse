DO $$
DECLARE
    baseline_retention JSONB := '{"traces":30,"datasets":90,"feedback":90}'::jsonb;
    baseline_redaction JSONB := '{"mode":"none","keys":[]}'::jsonb;
    custom_project_id UUID := '10500000-0000-4000-8000-000000000001';
    draft_project_id UUID := '10500000-0000-4000-8000-000000000002';
    new_project_id UUID := '10500000-0000-4000-8000-000000000003';
    custom_policy_id UUID;
    draft_policy_id UUID := '10500000-0000-4000-8000-000000000012';
    custom_version_id UUID := '10500000-0000-4000-8000-000000000021';
    draft_version_id UUID := '10500000-0000-4000-8000-000000000022';
    version_count_before INTEGER;
    audit_count_before INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM governance_policy_versions policy_version
        JOIN governance_policy_approvals approval ON approval.policy_version_id = policy_version.id
        WHERE policy_version.project_id = '11111111-1111-1111-1111-111111111111'
          AND policy_version.retention = baseline_retention
          AND policy_version.redaction = baseline_redaction
    ) THEN
        RAISE EXCEPTION 'existing project did not receive the approved default policy';
    END IF;

    INSERT INTO projects (id, organization_id, name, slug)
    VALUES (custom_project_id, '00000000-0000-4000-8000-000000000001', 'Custom approved governance', 'custom-approved-governance');
    SELECT id INTO custom_policy_id FROM governance_policies WHERE project_id = custom_project_id;
    INSERT INTO governance_policy_versions (id, policy_id, organization_id, project_id, version, retention, redaction, content_hash, created_by)
    VALUES (custom_version_id, custom_policy_id, '00000000-0000-4000-8000-000000000001', custom_project_id, 2, '{"traces":7}'::jsonb, baseline_redaction, repeat('c', 64), 'migration-test');
    INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type)
    VALUES ('00000000-0000-4000-8000-000000000001', custom_project_id, custom_version_id, 'migration-test', 'policy_created');
    INSERT INTO governance_policy_approvals (policy_version_id, organization_id, project_id, actor_subject)
    VALUES (custom_version_id, '00000000-0000-4000-8000-000000000001', custom_project_id, 'migration-test');
    INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type)
    VALUES ('00000000-0000-4000-8000-000000000001', custom_project_id, custom_version_id, 'migration-test', 'policy_approved');
    PERFORM ensure_default_governance_policy('00000000-0000-4000-8000-000000000001', custom_project_id);
    IF (SELECT count(*) FROM governance_policy_versions WHERE project_id = custom_project_id) <> 2
       OR NOT EXISTS (SELECT 1 FROM governance_policy_approvals WHERE policy_version_id = custom_version_id) THEN
        RAISE EXCEPTION 'custom approved policy was replaced';
    END IF;

    ALTER TABLE projects DISABLE TRIGGER projects_default_governance_policy;
    INSERT INTO projects (id, organization_id, name, slug)
    VALUES (draft_project_id, '00000000-0000-4000-8000-000000000001', 'Draft governance', 'draft-governance');
    ALTER TABLE projects ENABLE TRIGGER projects_default_governance_policy;
    INSERT INTO governance_policies (id, organization_id, project_id)
    VALUES (draft_policy_id, '00000000-0000-4000-8000-000000000001', draft_project_id);
    INSERT INTO governance_policy_versions (id, policy_id, organization_id, project_id, version, retention, redaction, content_hash, created_by)
    VALUES (draft_version_id, draft_policy_id, '00000000-0000-4000-8000-000000000001', draft_project_id, 1, '{"traces":14}'::jsonb, baseline_redaction, repeat('d', 64), 'migration-test');
    INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type)
    VALUES ('00000000-0000-4000-8000-000000000001', draft_project_id, draft_version_id, 'migration-test', 'policy_created');
    PERFORM ensure_default_governance_policy('00000000-0000-4000-8000-000000000001', draft_project_id);
    IF NOT EXISTS (SELECT 1 FROM governance_policy_versions WHERE id = draft_version_id AND version = 1)
       OR NOT EXISTS (
           SELECT 1 FROM governance_audit_events
           WHERE project_id = draft_project_id
             AND policy_version_id = draft_version_id
             AND actor_subject = 'migration-test'
             AND event_type = 'policy_created'
       )
       OR NOT EXISTS (
           SELECT 1 FROM governance_policy_versions policy_version
           JOIN governance_policy_approvals approval ON approval.policy_version_id = policy_version.id
           WHERE policy_version.project_id = draft_project_id
             AND policy_version.version = 2
             AND policy_version.retention = baseline_retention
             AND policy_version.redaction = baseline_redaction
       ) THEN
        RAISE EXCEPTION 'draft history was changed';
    END IF;
    SELECT count(*) INTO version_count_before FROM governance_policy_versions WHERE project_id = draft_project_id;
    SELECT count(*) INTO audit_count_before FROM governance_audit_events WHERE project_id = draft_project_id;
    PERFORM ensure_default_governance_policy('00000000-0000-4000-8000-000000000001', draft_project_id);
    IF (SELECT count(*) FROM governance_policy_versions WHERE project_id = draft_project_id) <> version_count_before
       OR (SELECT count(*) FROM governance_audit_events WHERE project_id = draft_project_id) <> audit_count_before THEN
        RAISE EXCEPTION 'default policy provisioning was not idempotent';
    END IF;

    INSERT INTO projects (id, organization_id, name, slug)
    VALUES (new_project_id, '00000000-0000-4000-8000-000000000001', 'New default governance', 'new-default-governance');
    IF NOT EXISTS (
        SELECT 1
        FROM governance_policy_versions policy_version
        JOIN governance_policy_approvals approval ON approval.policy_version_id = policy_version.id
        WHERE policy_version.project_id = new_project_id
          AND policy_version.version = 1
          AND policy_version.retention = baseline_retention
          AND policy_version.redaction = baseline_redaction
    ) OR (SELECT count(*) FROM governance_policy_versions WHERE project_id = new_project_id) <> 1
      OR (
          SELECT count(*)
          FROM governance_audit_events
          WHERE project_id = new_project_id
            AND actor_subject = 'system:governance-defaults'
            AND event_type IN ('policy_created', 'policy_approved')
      ) <> 2
      OR EXISTS (SELECT 1 FROM governance_retention_runs WHERE project_id = new_project_id) THEN
        RAISE EXCEPTION 'new project did not receive the approved default policy';
    END IF;
END;
$$;
