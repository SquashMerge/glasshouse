INSERT INTO projects (id, organization_id, name, slug)
VALUES (
    '67000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'Dataset curation fixture',
    'dataset-curation-fixture'
);

INSERT INTO datasets (id, project_id, slug, name)
VALUES (
    '67000000-0000-4000-8000-000000000002',
    '67000000-0000-4000-8000-000000000001',
    'dataset-curation-fixture',
    'Dataset curation fixture'
);

INSERT INTO dataset_drafts (id, project_id, dataset_id, created_by)
VALUES (
    '67000000-0000-4000-8000-000000000003',
    '67000000-0000-4000-8000-000000000001',
    '67000000-0000-4000-8000-000000000002',
    durable_actor_id('basic:v1', 'bootstrap-owner')
);

ALTER TABLE dataset_draft_items
    DROP CONSTRAINT IF EXISTS dataset_draft_items_input_check;
ALTER TABLE dataset_version_items
    DROP CONSTRAINT IF EXISTS dataset_version_items_input_check;

INSERT INTO dataset_draft_items (id, project_id, draft_id, item_key, position, input, expected_output, metadata)
VALUES (
    '67000000-0000-4000-8000-000000000004',
    '67000000-0000-4000-8000-000000000001',
    '67000000-0000-4000-8000-000000000003',
    'legacy-curation-case',
    0,
    '{"question":"safe"}'::jsonb,
    '{"answer":"safe"}'::jsonb,
    '{"cohort":"fixture"}'::jsonb
);

INSERT INTO dataset_draft_items (id, project_id, draft_id, item_key, position, input, expected_output, metadata)
VALUES (
    '67000000-0000-4000-8000-000000000005',
    '67000000-0000-4000-8000-000000000001',
    '67000000-0000-4000-8000-000000000003',
    'legacy-invalid-draft-case',
    1,
    '["legacy"]'::jsonb,
    '"legacy output"'::jsonb,
    '{}'::jsonb
);

INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash)
VALUES (
    '67000000-0000-4000-8000-000000000006',
    '67000000-0000-4000-8000-000000000001',
    '67000000-0000-4000-8000-000000000002',
    1,
    1,
    repeat('a', 64)
);

UPDATE datasets
SET latest_published_version = 1
WHERE id = '67000000-0000-4000-8000-000000000002';

INSERT INTO dataset_version_items (id, project_id, dataset_version_id, item_key, position, input, expected_output, metadata)
VALUES (
    '67000000-0000-4000-8000-000000000007',
    '67000000-0000-4000-8000-000000000001',
    '67000000-0000-4000-8000-000000000006',
    'legacy-invalid-version-case',
    0,
    '42'::jsonb,
    '["legacy output"]'::jsonb,
    '{}'::jsonb
);
