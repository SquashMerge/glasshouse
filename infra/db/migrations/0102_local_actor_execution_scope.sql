-- Execution requester provenance accepts the same human identity providers as
-- the request boundary. Legacy rows and internal worker identities are untouched.
CREATE OR REPLACE FUNCTION enforce_experiment_requester_actor_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.requested_by_actor_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects project JOIN actor_identities identity
            ON identity.organization_id = project.organization_id
            AND identity.actor_id = NEW.requested_by_actor_id
            AND identity.provider_namespace IN ('basic:v1', 'local:v1')
        WHERE project.id = NEW.project_id
            AND local_actor_authentication_enabled(project.organization_id, identity.actor_id)
    ) THEN
        RAISE EXCEPTION 'experiment requester actor is not scoped to the project organization' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_evaluation_run_requester_actor_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM projects project JOIN actor_identities identity
            ON identity.organization_id = project.organization_id
            AND identity.actor_id = NEW.requested_by_actor_id
            AND identity.provider_namespace IN ('basic:v1', 'local:v1')
        WHERE project.id = NEW.project_id AND project.organization_id = NEW.organization_id
            AND local_actor_authentication_enabled(project.organization_id, identity.actor_id)
    ) THEN
        RAISE EXCEPTION 'evaluation run requester actor is not scoped to the project organization' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
