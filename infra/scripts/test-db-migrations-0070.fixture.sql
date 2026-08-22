INSERT INTO projects (id, organization_id, name, slug)
VALUES (
    '70000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'Dataset revision-history fixture',
    'dataset-revision-history-fixture'
);

INSERT INTO actors (id)
VALUES (durable_actor_id('basic:v1', 'bootstrap-owner'));

INSERT INTO datasets (id, project_id, slug, name)
VALUES (
    '70000000-0000-4000-8000-000000000002',
    '70000000-0000-4000-8000-000000000001',
    'dataset-revision-history-fixture',
    'Dataset revision-history fixture'
);

INSERT INTO dataset_drafts (id, project_id, dataset_id, created_by)
VALUES (
    '70000000-0000-4000-8000-000000000003',
    '70000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002',
    durable_actor_id('basic:v1', 'bootstrap-owner')
);

INSERT INTO dataset_draft_items (
    id, project_id, draft_id, item_key, position, input, expected_output,
    metadata, created_by, updated_by
) VALUES (
    '70000000-0000-4000-8000-000000000004',
    '70000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000003',
    'retained-case',
    0,
    '{"question":"safe"}'::jsonb,
    '{"answer":"safe"}'::jsonb,
    '{}'::jsonb,
    durable_actor_id('basic:v1', 'bootstrap-owner'),
    durable_actor_id('basic:v1', 'bootstrap-owner')
);

INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash)
VALUES (
    '70000000-0000-4000-8000-000000000005',
    '70000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002',
    1,
    1,
    repeat('a', 64)
);

INSERT INTO dataset_version_items (
    id, project_id, dataset_version_id, item_key, position, input,
    expected_output, metadata
) VALUES (
    '70000000-0000-4000-8000-000000000006',
    '70000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000005',
    'retained-case',
    0,
    '{"question":"safe"}'::jsonb,
    '{"answer":"safe"}'::jsonb,
    '{}'::jsonb
);

INSERT INTO dataset_draft_item_revisions (
    id, project_id, draft_item_id, item_revision, item_key, position,
    validation_version, state, input, expected_output, metadata, actor_id, action
) VALUES (
    '70000000-0000-4000-8000-000000000007',
    '70000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000004',
    1,
    'retained-case',
    0,
    1,
    'reviewed',
    '{"question":"safe"}'::jsonb,
    '{"answer":"safe"}'::jsonb,
    '{}'::jsonb,
    durable_actor_id('basic:v1', 'bootstrap-owner'),
    'reviewed'
);
