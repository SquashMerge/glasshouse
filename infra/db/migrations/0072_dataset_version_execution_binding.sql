-- Bind new executions to one immutable Dataset Version without inventing legacy history.
ALTER TABLE dataset_versions
    ADD COLUMN IF NOT EXISTS published_by UUID,
    ADD COLUMN IF NOT EXISTS published_draft_revision INTEGER;

ALTER TABLE experiments
    ADD COLUMN IF NOT EXISTS resolved_dataset_version_id UUID,
    ADD COLUMN IF NOT EXISTS dataset_input_binding TEXT;

UPDATE experiments
SET dataset_input_binding = 'legacy_unversioned'
WHERE dataset_input_binding IS NULL;

ALTER TABLE experiments
    ALTER COLUMN dataset_input_binding SET NOT NULL,
    ALTER COLUMN dataset_input_binding SET DEFAULT 'legacy_unversioned';
ALTER TABLE experiments
    DROP CONSTRAINT IF EXISTS experiments_dataset_input_binding_check;
ALTER TABLE experiments
    ADD CONSTRAINT experiments_dataset_input_binding_check CHECK (
        (dataset_input_binding = 'legacy_unversioned' AND resolved_dataset_version_id IS NULL)
        OR (dataset_input_binding = 'versioned' AND resolved_dataset_version_id IS NOT NULL)
    );
ALTER TABLE experiments
    DROP CONSTRAINT IF EXISTS experiments_project_resolved_dataset_version_fkey;
CREATE UNIQUE INDEX IF NOT EXISTS dataset_versions_project_dataset_id_id_key
    ON dataset_versions(project_id, dataset_id, id);
ALTER TABLE experiments
    ADD CONSTRAINT experiments_project_resolved_dataset_version_fkey
    FOREIGN KEY (project_id, dataset_id, resolved_dataset_version_id)
    REFERENCES dataset_versions(project_id, dataset_id, id) ON DELETE RESTRICT;

UPDATE experiment_tasks
SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
WHERE experiment_id IN (
    SELECT id FROM experiments
    WHERE dataset_input_binding = 'legacy_unversioned'
      AND status IN ('pending', 'running')
) AND status IN ('pending', 'running');
UPDATE experiments
SET status = 'cancelled', updated_at = now()
WHERE dataset_input_binding = 'legacy_unversioned'
  AND status IN ('pending', 'running');

CREATE OR REPLACE FUNCTION seed_experiment_tasks() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.dataset_input_binding <> 'versioned' OR NEW.resolved_dataset_version_id IS NULL THEN
        RETURN NEW;
    END IF;
    INSERT INTO experiment_tasks (project_id, experiment_id, dataset_version_item_id)
    SELECT NEW.project_id, NEW.id, item.id
    FROM dataset_version_items item
    WHERE item.project_id = NEW.project_id
      AND item.dataset_version_id = NEW.resolved_dataset_version_id
    ON CONFLICT (experiment_id, dataset_version_item_id)
        WHERE dataset_version_item_id IS NOT NULL DO NOTHING;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION prevent_experiment_dataset_binding_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.dataset_id <> OLD.dataset_id
       OR NEW.resolved_dataset_version_id IS DISTINCT FROM OLD.resolved_dataset_version_id
       OR NEW.dataset_input_binding <> OLD.dataset_input_binding THEN
        RAISE EXCEPTION 'experiment dataset input binding is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS experiments_dataset_binding_immutable ON experiments;
CREATE TRIGGER experiments_dataset_binding_immutable
BEFORE UPDATE ON experiments
FOR EACH ROW EXECUTE FUNCTION prevent_experiment_dataset_binding_mutation();
