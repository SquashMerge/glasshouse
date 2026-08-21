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
