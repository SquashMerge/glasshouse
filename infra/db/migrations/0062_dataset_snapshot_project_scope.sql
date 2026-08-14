-- Scope every immutable snapshot reference to the experiment's project.
CREATE UNIQUE INDEX IF NOT EXISTS experiments_project_id_id_key ON experiments(project_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS dataset_version_items_project_id_id_key ON dataset_version_items(project_id, id);

ALTER TABLE experiments DROP CONSTRAINT IF EXISTS experiments_project_dataset_fkey;
ALTER TABLE experiments ADD CONSTRAINT experiments_project_dataset_fkey
    FOREIGN KEY (project_id, dataset_id) REFERENCES datasets(project_id, id) ON DELETE RESTRICT;

ALTER TABLE experiment_tasks ADD COLUMN IF NOT EXISTS project_id UUID;
UPDATE experiment_tasks task SET project_id = experiment.project_id
FROM experiments experiment
WHERE task.experiment_id = experiment.id AND task.project_id IS NULL;
ALTER TABLE experiment_tasks ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE experiment_tasks DROP CONSTRAINT IF EXISTS experiment_tasks_project_experiment_fkey;
ALTER TABLE experiment_tasks ADD CONSTRAINT experiment_tasks_project_experiment_fkey
    FOREIGN KEY (project_id, experiment_id) REFERENCES experiments(project_id, id) ON DELETE CASCADE;
ALTER TABLE experiment_tasks DROP CONSTRAINT IF EXISTS experiment_tasks_project_version_item_fkey;
ALTER TABLE experiment_tasks ADD CONSTRAINT experiment_tasks_project_version_item_fkey
    FOREIGN KEY (project_id, dataset_version_item_id) REFERENCES dataset_version_items(project_id, id) ON DELETE RESTRICT;

ALTER TABLE experiment_results ADD COLUMN IF NOT EXISTS project_id UUID;
UPDATE experiment_results result SET project_id = experiment.project_id
FROM experiments experiment
WHERE result.experiment_id = experiment.id AND result.project_id IS NULL;
ALTER TABLE experiment_results ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE experiment_results DROP CONSTRAINT IF EXISTS experiment_results_project_experiment_fkey;
ALTER TABLE experiment_results ADD CONSTRAINT experiment_results_project_experiment_fkey
    FOREIGN KEY (project_id, experiment_id) REFERENCES experiments(project_id, id) ON DELETE CASCADE;
ALTER TABLE experiment_results DROP CONSTRAINT IF EXISTS experiment_results_project_version_item_fkey;
ALTER TABLE experiment_results ADD CONSTRAINT experiment_results_project_version_item_fkey
    FOREIGN KEY (project_id, dataset_version_item_id) REFERENCES dataset_version_items(project_id, id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION seed_experiment_tasks() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO experiment_tasks (project_id, experiment_id, dataset_version_item_id)
    SELECT NEW.project_id, NEW.id, item.id
    FROM datasets dataset
    JOIN dataset_versions version ON version.project_id = dataset.project_id
        AND version.dataset_id = dataset.id AND version.version = dataset.latest_published_version
    JOIN dataset_version_items item ON item.project_id = version.project_id
        AND item.dataset_version_id = version.id
    WHERE dataset.id = NEW.dataset_id AND dataset.project_id = NEW.project_id
    ON CONFLICT (experiment_id, dataset_version_item_id) WHERE dataset_version_item_id IS NOT NULL DO NOTHING;
    RETURN NEW;
END $$;
