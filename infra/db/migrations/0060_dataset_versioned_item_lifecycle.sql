-- Repair legacy item shapes before versioned consumers rely on object inputs.
CREATE TABLE IF NOT EXISTS dataset_item_input_quarantine (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    dataset_id UUID NOT NULL,
    dataset_item_id UUID NOT NULL UNIQUE REFERENCES dataset_items(id) ON DELETE RESTRICT,
    original_input JSONB NOT NULL,
    reason TEXT NOT NULL CHECK (reason = 'input_not_object'),
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, dataset_id) REFERENCES datasets(project_id, id) ON DELETE RESTRICT
);
INSERT INTO dataset_item_input_quarantine (project_id, dataset_id, dataset_item_id, original_input, reason)
SELECT d.project_id, i.dataset_id, i.id, i.input, 'input_not_object'
FROM dataset_items i JOIN datasets d ON d.id = i.dataset_id
WHERE jsonb_typeof(i.input) <> 'object'
ON CONFLICT (dataset_item_id) DO NOTHING;
UPDATE dataset_items SET input = jsonb_build_object('legacy_input', input)
WHERE jsonb_typeof(input) <> 'object';

ALTER TABLE experiment_tasks ADD COLUMN IF NOT EXISTS dataset_version_item_id UUID;
ALTER TABLE experiment_tasks ALTER COLUMN dataset_item_id DROP NOT NULL;
ALTER TABLE experiment_tasks DROP CONSTRAINT IF EXISTS experiment_tasks_dataset_item_id_fkey;
ALTER TABLE experiment_tasks ADD CONSTRAINT experiment_tasks_dataset_item_id_fkey FOREIGN KEY (dataset_item_id) REFERENCES dataset_items(id) ON DELETE RESTRICT;
ALTER TABLE experiment_tasks ADD CONSTRAINT experiment_tasks_dataset_version_item_id_fkey FOREIGN KEY (dataset_version_item_id) REFERENCES dataset_version_items(id) ON DELETE RESTRICT;
ALTER TABLE experiment_tasks ADD CONSTRAINT experiment_tasks_one_item_identity CHECK ((dataset_item_id IS NULL) <> (dataset_version_item_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS experiment_tasks_version_item_key ON experiment_tasks(experiment_id, dataset_version_item_id) WHERE dataset_version_item_id IS NOT NULL;

ALTER TABLE experiment_results ADD COLUMN IF NOT EXISTS dataset_version_item_id UUID;
ALTER TABLE experiment_results ALTER COLUMN dataset_item_id DROP NOT NULL;
ALTER TABLE experiment_results DROP CONSTRAINT IF EXISTS experiment_results_dataset_item_id_fkey;
ALTER TABLE experiment_results ADD CONSTRAINT experiment_results_dataset_item_id_fkey FOREIGN KEY (dataset_item_id) REFERENCES dataset_items(id) ON DELETE RESTRICT;
ALTER TABLE experiment_results ADD CONSTRAINT experiment_results_dataset_version_item_id_fkey FOREIGN KEY (dataset_version_item_id) REFERENCES dataset_version_items(id) ON DELETE RESTRICT;
ALTER TABLE experiment_results ADD CONSTRAINT experiment_results_one_item_identity CHECK ((dataset_item_id IS NULL) <> (dataset_version_item_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS experiment_results_version_item_key ON experiment_results(experiment_id, dataset_version_item_id) WHERE dataset_version_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION seed_experiment_tasks() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO experiment_tasks (experiment_id, dataset_version_item_id)
    SELECT NEW.id, item.id
    FROM datasets d
    JOIN dataset_versions v ON v.dataset_id = d.id AND v.version = d.latest_published_version
    JOIN dataset_version_items item ON item.dataset_version_id = v.id
    WHERE d.id = NEW.dataset_id AND d.project_id = NEW.project_id
    ON CONFLICT (experiment_id, dataset_version_item_id) WHERE dataset_version_item_id IS NOT NULL DO NOTHING;
    RETURN NEW;
END $$;

ALTER TABLE dataset_draft_items ADD COLUMN IF NOT EXISTS feedback_score_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS dataset_draft_items_feedback_score_id_unique ON dataset_draft_items(feedback_score_id) WHERE feedback_score_id IS NOT NULL;
ALTER TABLE dataset_lifecycle_audit_events DROP CONSTRAINT IF EXISTS dataset_lifecycle_audit_events_event_type_check;
ALTER TABLE dataset_lifecycle_audit_events ADD CONSTRAINT dataset_lifecycle_audit_events_event_type_check CHECK (event_type IN ('created', 'metadata_updated', 'archived', 'restored', 'draft_created', 'draft_discarded', 'draft_item_upserted', 'draft_item_deleted'));
ALTER TABLE feedback_reviews ADD COLUMN IF NOT EXISTS dataset_draft_item_id UUID REFERENCES dataset_draft_items(id) ON DELETE RESTRICT;
ALTER TABLE feedback_reviews DROP CONSTRAINT IF EXISTS feedback_reviews_added_dataset_link_check;
ALTER TABLE feedback_reviews ADD CONSTRAINT feedback_reviews_added_dataset_link_check CHECK (
    (status = 'added_to_dataset' AND dataset_id IS NOT NULL AND ((dataset_item_id IS NOT NULL) <> (dataset_draft_item_id IS NOT NULL)))
    OR (status <> 'added_to_dataset' AND dataset_id IS NULL AND dataset_item_id IS NULL AND dataset_draft_item_id IS NULL)
);
