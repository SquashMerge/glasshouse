-- Tombstoned Evaluations retain their final lifecycle state until project deletion.
CREATE OR REPLACE FUNCTION prevent_tombstoned_evaluation_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF project_deletion_is_authorized(OLD.project_id) THEN RETURN OLD; END IF;
        IF OLD.tombstoned_at IS NOT NULL THEN
            RAISE EXCEPTION 'tombstoned evaluations are immutable' USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.tombstoned_at IS NOT NULL THEN
        RAISE EXCEPTION 'tombstoned evaluations are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS evaluations_tombstone_immutable ON evaluations;
CREATE TRIGGER evaluations_tombstone_immutable
BEFORE UPDATE OR DELETE ON evaluations
FOR EACH ROW EXECUTE FUNCTION prevent_tombstoned_evaluation_mutation();
