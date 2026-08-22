INSERT INTO actors (id)
VALUES (durable_actor_id('basic:v1', 'bootstrap-owner'));

INSERT INTO actor_identities (
    actor_id, organization_id, provider_namespace, canonical_subject
)
VALUES (
    durable_actor_id('basic:v1', 'bootstrap-owner'),
    '00000000-0000-4000-8000-000000000001',
    'basic:v1',
    'bootstrap-owner'
);

INSERT INTO organization_actor_roles (organization_id, actor_id, role)
VALUES (
    '00000000-0000-4000-8000-000000000001',
    durable_actor_id('basic:v1', 'bootstrap-owner'),
    'admin'
);

INSERT INTO projects (id, organization_id, name, slug)
VALUES (
    '68000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'Dataset curation idempotency fixture',
    'dataset-curation-idempotency-fixture'
);

DO $$
DECLARE
    fixture_organization_id UUID := '00000000-0000-4000-8000-000000000001';
    fixture_project_id UUID := '68000000-0000-4000-8000-000000000001';
    fixture_actor_id UUID := durable_actor_id('basic:v1', 'bootstrap-owner');
BEGIN
    IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = fixture_organization_id) THEN
        RAISE EXCEPTION '0068 fixture organization prerequisite is missing';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM actors WHERE id = fixture_actor_id) THEN
        RAISE EXCEPTION '0068 fixture durable actor prerequisite is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM actor_identities
        WHERE actor_id = fixture_actor_id
          AND organization_id = fixture_organization_id
          AND provider_namespace = 'basic:v1'
          AND canonical_subject = 'bootstrap-owner'
    ) THEN
        RAISE EXCEPTION '0068 fixture organization actor identity prerequisite is missing';
    END IF;

    IF NOT authorization_allows_project(
        fixture_organization_id,
        fixture_project_id,
        fixture_actor_id,
        'product_write'
    ) THEN
        RAISE EXCEPTION '0068 fixture actor authorization prerequisite is missing';
    END IF;
END
$$;

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
