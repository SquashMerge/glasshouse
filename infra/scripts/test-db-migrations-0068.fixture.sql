INSERT INTO projects (id, organization_id, name, slug)
VALUES (
    '68000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'Dataset curation idempotency fixture',
    'dataset-curation-idempotency-fixture'
);

INSERT INTO datasets (id, project_id, slug, name)
VALUES
    (
        '68000000-0000-4000-8000-000000000002',
        '68000000-0000-4000-8000-000000000001',
        'legacy-curation-target',
        'Legacy curation target'
    ),
    (
        '68000000-0000-4000-8000-000000000004',
        '68000000-0000-4000-8000-000000000001',
        'deleted-curation-target',
        'Deleted curation target'
    );

INSERT INTO dataset_drafts (id, project_id, dataset_id, created_by)
VALUES
    (
        '68000000-0000-4000-8000-000000000003',
        '68000000-0000-4000-8000-000000000001',
        '68000000-0000-4000-8000-000000000002',
        durable_actor_id('basic:v1', 'bootstrap-owner')
    ),
    (
        '68000000-0000-4000-8000-000000000005',
        '68000000-0000-4000-8000-000000000001',
        '68000000-0000-4000-8000-000000000004',
        durable_actor_id('basic:v1', 'bootstrap-owner')
    );

INSERT INTO dataset_curation_idempotency (
    project_id, actor_id, operation, idempotency_key, request_hash, response
)
VALUES
    (
        '68000000-0000-4000-8000-000000000001',
        durable_actor_id('basic:v1', 'bootstrap-owner'),
        'import',
        'legacy-import-key',
        repeat('a', 64),
        jsonb_build_object(
            'draft_id', '68000000-0000-4000-8000-000000000003',
            'revision', 2,
            'item_ids', jsonb_build_array('68000000-0000-4000-8000-000000000006')
        )
    ),
    (
        '68000000-0000-4000-8000-000000000001',
        durable_actor_id('basic:v1', 'bootstrap-owner'),
        'capture',
        'deleted-target-key',
        repeat('b', 64),
        jsonb_build_object(
            'draft_id', '68000000-0000-4000-8000-000000000005',
            'revision', 2,
            'item_ids', jsonb_build_array('68000000-0000-4000-8000-000000000007')
        )
    );
