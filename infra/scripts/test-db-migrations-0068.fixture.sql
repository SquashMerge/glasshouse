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
    ),
    (
        '68000000-0000-4000-8000-000000000008',
        '68000000-0000-4000-8000-000000000001',
        'audit-recovered-target',
        'Audit recovered target'
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
    project_id, actor_id, operation, idempotency_key, request_hash, response, created_at
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
        ),
        now()
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
        ),
        now()
    ),
    (
        '68000000-0000-4000-8000-000000000001',
        durable_actor_id('basic:v1', 'bootstrap-owner'),
        'import',
        'consumed-draft-key',
        repeat('c', 64),
        jsonb_build_object(
            'draft_id', '68000000-0000-4000-8000-000000000009',
            'revision', 3,
            'item_ids', jsonb_build_array('68000000-0000-4000-8000-000000000010')
        ),
        '2026-08-20T00:00:00.000Z'
    );

INSERT INTO dataset_lifecycle_audit_events (
    organization_id, project_id, dataset_id, slug, actor_id, event_type,
    draft_revision, created_at
)
VALUES (
    '00000000-0000-4000-8000-000000000001',
    '68000000-0000-4000-8000-000000000001',
    '68000000-0000-4000-8000-000000000008',
    'audit-recovered-target',
    durable_actor_id('basic:v1', 'bootstrap-owner'),
    'draft_items_imported',
    3,
    '2026-08-20T00:00:00.000Z'
);
