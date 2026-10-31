-- Historical scores have unknown authors: leave them unattributed and unchanged.
ALTER TABLE scores ADD COLUMN IF NOT EXISTS feedback_actor_id UUID REFERENCES actors(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS scores_feedback_actor_target_key
    ON scores (project_id, feedback_actor_id, trace_id, observation_id) NULLS NOT DISTINCT
    WHERE name = 'human.feedback' AND feedback_actor_id IS NOT NULL;

ALTER TABLE scores ADD CONSTRAINT scores_feedback_actor_target_check
    CHECK (feedback_actor_id IS NULL OR (name = 'human.feedback' AND trace_id IS NOT NULL));

CREATE OR REPLACE FUNCTION check_feedback_actor_organization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.feedback_actor_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM projects p JOIN actor_identities i ON i.organization_id = p.organization_id
        WHERE p.id = NEW.project_id AND i.actor_id = NEW.feedback_actor_id
    ) THEN
        RAISE EXCEPTION 'feedback Actor is outside the Project organization' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS scores_feedback_actor_organization ON scores;
CREATE TRIGGER scores_feedback_actor_organization BEFORE INSERT OR UPDATE OF feedback_actor_id, project_id ON scores
    FOR EACH ROW EXECUTE FUNCTION check_feedback_actor_organization();
