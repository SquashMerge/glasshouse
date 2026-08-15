INSERT INTO actors (id)
VALUES (durable_actor_id('basic:v1', 'legacy-item-link-fixture'));

INSERT INTO actor_identities (
    actor_id,
    organization_id,
    provider_namespace,
    canonical_subject
)
VALUES (
    durable_actor_id('basic:v1', 'legacy-item-link-fixture'),
    '00000000-0000-4000-8000-000000000001',
    'basic:v1',
    'legacy-item-link-fixture'
);

INSERT INTO projects (id, organization_id, name, slug)
VALUES
    (
        '64000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000001',
        'Legacy item links A',
        'legacy-item-links-a'
    ),
    (
        '64000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000001',
        'Legacy item links B',
        'legacy-item-links-b'
    );

INSERT INTO datasets (id, project_id, slug, name)
VALUES
    (
        '64000000-0000-4000-8000-000000000010',
        '64000000-0000-4000-8000-000000000001',
        'legacy-item-links-a',
        'Legacy item links A'
    ),
    (
        '64000000-0000-4000-8000-000000000020',
        '64000000-0000-4000-8000-000000000002',
        'legacy-item-links-b',
        'Legacy item links B'
    );

INSERT INTO dataset_items (id, dataset_id, input)
VALUES
    (
        '64000000-0000-4000-8000-000000000011',
        '64000000-0000-4000-8000-000000000010',
        '{"question":"owned by A"}'::jsonb
    ),
    (
        '64000000-0000-4000-8000-000000000021',
        '64000000-0000-4000-8000-000000000020',
        '{"question":"owned by B"}'::jsonb
    );

INSERT INTO experiments (
    id,
    project_id,
    dataset_id,
    status,
    config,
    requested_by_actor_id
)
VALUES
    (
        '64000000-0000-4000-8000-000000000100',
        '64000000-0000-4000-8000-000000000001',
        '64000000-0000-4000-8000-000000000010',
        'pending',
        '{}'::jsonb,
        durable_actor_id('basic:v1', 'legacy-item-link-fixture')
    ),
    (
        '64000000-0000-4000-8000-000000000101',
        '64000000-0000-4000-8000-000000000001',
        '64000000-0000-4000-8000-000000000010',
        'completed',
        '{}'::jsonb,
        NULL
    );

INSERT INTO experiment_tasks (
    id,
    project_id,
    experiment_id,
    dataset_item_id,
    status
)
VALUES
    (
        '64000000-0000-4000-8000-000000000110',
        '64000000-0000-4000-8000-000000000001',
        '64000000-0000-4000-8000-000000000100',
        '64000000-0000-4000-8000-000000000021',
        'pending'
    ),
    (
        '64000000-0000-4000-8000-000000000111',
        '64000000-0000-4000-8000-000000000001',
        '64000000-0000-4000-8000-000000000101',
        '64000000-0000-4000-8000-000000000011',
        'completed'
    );

INSERT INTO experiment_results (
    id,
    project_id,
    experiment_id,
    dataset_item_id,
    output,
    scores,
    status
)
VALUES (
    '64000000-0000-4000-8000-000000000120',
    '64000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000100',
    '64000000-0000-4000-8000-000000000021',
    '{}'::jsonb,
    '{}'::jsonb,
    'failed'
);
