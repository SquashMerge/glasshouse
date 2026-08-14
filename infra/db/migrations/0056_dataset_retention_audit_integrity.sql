-- Dataset audit evidence is project-local and append-only except while an
-- authorized retention or permanent-project deletion removes its content.
ALTER TABLE dataset_lifecycle_audit_events
    ADD CONSTRAINT dataset_lifecycle_audit_events_dataset_project_fkey
    FOREIGN KEY (project_id, dataset_id)
    REFERENCES datasets(project_id, id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION prevent_dataset_tombstone_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'dataset tombstones are immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION prevent_dataset_lifecycle_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND (
        project_deletion_is_authorized(OLD.project_id)
        OR current_setting('astraea.dataset_retention_project_id', true) = OLD.project_id::text
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'dataset lifecycle audit events are append-only' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS dataset_tombstones_immutable ON dataset_tombstones;
CREATE TRIGGER dataset_tombstones_immutable
BEFORE UPDATE OR DELETE ON dataset_tombstones
FOR EACH ROW EXECUTE FUNCTION prevent_dataset_tombstone_mutation();

DROP TRIGGER IF EXISTS dataset_lifecycle_audit_immutable ON dataset_lifecycle_audit_events;
CREATE TRIGGER dataset_lifecycle_audit_immutable
BEFORE UPDATE OR DELETE ON dataset_lifecycle_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_dataset_lifecycle_audit_mutation();
