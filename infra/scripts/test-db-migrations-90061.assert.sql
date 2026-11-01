BEGIN;
DO $$
DECLARE
    organization UUID := gen_random_uuid();
    project UUID := gen_random_uuid();
    actor UUID := gen_random_uuid();
    score UUID := gen_random_uuid();
    foreign_organization UUID := gen_random_uuid();
    foreign_project UUID := gen_random_uuid();
    foreign_actor UUID := gen_random_uuid();
    event UUID;
    column_names TEXT[];
BEGIN
    SELECT array_agg(attname ORDER BY attname) INTO column_names
    FROM pg_attribute
    WHERE attrelid = 'user_action_audit_events'::regclass
      AND attnum > 0
      AND NOT attisdropped;
    IF column_names IS DISTINCT FROM ARRAY[
        'action', 'actor_id', 'created_at', 'feedback_score_id', 'id',
        'organization_id', 'project_id', 'prompt_id', 'prompt_version'
    ] THEN
        RAISE EXCEPTION '90061 user action audit columns are not content-free: %', column_names;
    END IF;

    WITH inserted AS (
      INSERT INTO organizations (id, name, slug, default_project_id)
      VALUES (organization, 'User action fixture', organization::text, project)
      RETURNING id
    ) INSERT INTO projects (id, organization_id, name, slug)
      SELECT project, id, 'Default', 'default' FROM inserted;
    INSERT INTO actors (id) VALUES (actor);
    INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
      VALUES (actor, organization, 'basic:v1', organization::text);
    WITH inserted AS (
      INSERT INTO organizations (id, name, slug, default_project_id)
      VALUES (foreign_organization, 'Foreign fixture', foreign_organization::text, foreign_project)
      RETURNING id
    ) INSERT INTO projects (id, organization_id, name, slug)
      SELECT foreign_project, id, 'Default', 'default' FROM inserted;
    INSERT INTO actors (id) VALUES (foreign_actor);
    INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
      VALUES (foreign_actor, foreign_organization, 'basic:v1', foreign_organization::text);
    INSERT INTO scores (id, project_id, trace_id, name, value, feedback_actor_id)
      VALUES (score, project, repeat('a', 32), 'human.feedback', 1, actor);
    INSERT INTO user_action_audit_events (
      organization_id, project_id, actor_id, action, feedback_score_id
    ) VALUES (
      organization, project, actor, 'feedback_created', score
    ) RETURNING id INTO event;

    BEGIN
      INSERT INTO user_action_audit_events (
        organization_id, project_id, actor_id, action, feedback_score_id
      ) VALUES (
        organization, foreign_project, actor, 'feedback_created', score
      );
      RAISE EXCEPTION '90061 accepted a cross-organization Project';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO user_action_audit_events (
        organization_id, project_id, actor_id, action, feedback_score_id
      ) VALUES (
        organization, project, foreign_actor, 'feedback_created', score
      );
      RAISE EXCEPTION '90061 accepted an Actor outside the Organization';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;

    BEGIN
      INSERT INTO user_action_audit_events (
        organization_id, project_id, actor_id, action, feedback_score_id
      ) VALUES (
        organization, project, actor, 'feedback_created', score
      );
      RAISE EXCEPTION '90061 accepted duplicate feedback action scope';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
      UPDATE user_action_audit_events SET action = 'prompt_created' WHERE id = event;
      RAISE EXCEPTION '90061 accepted an audit event update';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;
    BEGIN
      DELETE FROM user_action_audit_events WHERE id = event;
      RAISE EXCEPTION '90061 accepted an audit event delete';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;
    IF pg_get_functiondef('prevent_project_audit_uuid_reuse'::regproc)
        NOT LIKE '%user_action_audit_events%' THEN
        RAISE EXCEPTION '90061 omitted user action events from the Project UUID reuse fence';
    END IF;
END $$;
ROLLBACK;
