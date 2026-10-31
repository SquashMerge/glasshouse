BEGIN;
DO $$
DECLARE
    org UUID := gen_random_uuid();
    project UUID := gen_random_uuid();
    actor UUID := gen_random_uuid();
    trace TEXT := repeat('a', 32);
BEGIN
    WITH inserted AS (
      INSERT INTO organizations (id, name, slug, default_project_id)
      VALUES (org, 'Feedback fixture', org::text, project) RETURNING id
    ) INSERT INTO projects (id, organization_id, name, slug)
      SELECT project, id, 'Default', 'default' FROM inserted;
    INSERT INTO actors (id) VALUES (actor);
    INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
      VALUES (actor, org, 'basic:v1', org::text);
    -- Unknown historical authors are intentionally not attributed or deduplicated.
    INSERT INTO scores (project_id, trace_id, name, value) VALUES
      (project, trace, 'human.feedback', 1), (project, trace, 'human.feedback', -1);
    INSERT INTO scores (project_id, trace_id, observation_id, name, value, feedback_actor_id) VALUES
      (project, trace, NULL, 'human.feedback', 1, actor),
      (project, trace, 'span-a', 'human.feedback', 1, actor),
      (project, trace, 'span-b', 'human.feedback', -1, actor);
    BEGIN
      INSERT INTO scores (project_id, trace_id, name, value, feedback_actor_id)
        VALUES (project, trace, 'human.feedback', -1, actor);
      RAISE EXCEPTION 'duplicate trace feedback was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO scores (project_id, trace_id, observation_id, name, value, feedback_actor_id)
        VALUES (project, trace, 'span-a', 'human.feedback', -1, actor);
      RAISE EXCEPTION 'duplicate span feedback was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    IF (SELECT count(*) FROM scores WHERE project_id = project AND feedback_actor_id IS NULL) <> 2 THEN
      RAISE EXCEPTION 'historical unknown feedback was lost';
    END IF;
END $$;
ROLLBACK;
