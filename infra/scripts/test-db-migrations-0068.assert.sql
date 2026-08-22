DO $$
DECLARE
    fixture_organization_id UUID := '00000000-0000-4000-8000-000000000001';
    fixture_project_id UUID := '68000000-0000-4000-8000-000000000001';
    fixture_legacy_dataset_id UUID := '68000000-0000-4000-8000-000000000002';
    fixture_deleted_dataset_id UUID := '68000000-0000-4000-8000-000000000004';
    fixture_audit_dataset_id UUID := '68000000-0000-4000-8000-000000000008';
    fixture_actor_id UUID := durable_actor_id('basic:v1', 'bootstrap-owner');
BEGIN
    IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = fixture_organization_id) THEN
        RAISE EXCEPTION '0068 fixture did not establish organization provenance';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM actors WHERE id = fixture_actor_id) THEN
        RAISE EXCEPTION '0068 fixture did not establish durable actor provenance';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM actor_identities
        WHERE actor_id = fixture_actor_id
          AND organization_id = fixture_organization_id
          AND provider_namespace = 'basic:v1'
          AND canonical_subject = 'bootstrap-owner'
    ) THEN
        RAISE EXCEPTION '0068 fixture did not establish organization-scoped actor provenance';
    END IF;

    IF NOT authorization_allows_project(
        fixture_organization_id,
        fixture_project_id,
        fixture_actor_id,
        'product_write'
    ) THEN
        RAISE EXCEPTION '0068 fixture actor is not authorized for lifecycle audit provenance';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM dataset_curation_idempotency
        WHERE project_id = fixture_project_id
          AND idempotency_key = 'legacy-import-key'
          AND dataset_id = fixture_legacy_dataset_id
    ) THEN
        RAISE EXCEPTION '0068 did not backfill the legacy curation target';
    END IF;

    DELETE FROM datasets
    WHERE project_id = fixture_project_id
      AND id = fixture_deleted_dataset_id;

    IF EXISTS (
        SELECT 1
        FROM dataset_curation_idempotency
        WHERE project_id = fixture_project_id
          AND idempotency_key = 'deleted-target-key'
          AND dataset_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION '0068 retained a deleted curation target reference';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM dataset_curation_idempotency
        WHERE project_id = fixture_project_id
          AND idempotency_key = 'consumed-draft-key'
          AND dataset_id = fixture_audit_dataset_id
    ) THEN
        RAISE EXCEPTION '0069 did not recover the consumed draft curation target from audit history';
    END IF;
END
$$;
