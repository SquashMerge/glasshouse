WITH organization AS (
    INSERT INTO organizations (id, name, slug, default_project_id)
    VALUES ('95000000-0000-4000-8000-000000000001', 'Execution Bounds Upgrade', 'execution-bounds-upgrade', '95000000-0000-4000-8000-000000000002')
    RETURNING id
)
INSERT INTO projects (id, organization_id, name, slug)
SELECT '95000000-0000-4000-8000-000000000002', id, 'Default Project', 'default'
FROM organization;

INSERT INTO actors (id) VALUES ('95000000-0000-4000-8000-000000000003');
INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
VALUES ('95000000-0000-4000-8000-000000000003', '95000000-0000-4000-8000-000000000001', 'basic:v1', 'execution-bounds-upgrade');
INSERT INTO organization_actor_roles (organization_id, actor_id, role)
VALUES ('95000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000003', 'user');
INSERT INTO project_actor_grants (project_id, organization_id, actor_id, role)
VALUES ('95000000-0000-4000-8000-000000000002', '95000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000003', 'user');

INSERT INTO datasets (id, project_id, name, slug)
VALUES ('95000000-0000-4000-8000-000000000004', '95000000-0000-4000-8000-000000000002', 'Upgrade Dataset', 'upgrade-dataset');
INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash, published_by, published_draft_revision)
VALUES ('95000000-0000-4000-8000-000000000005', '95000000-0000-4000-8000-000000000002', '95000000-0000-4000-8000-000000000004', 1, 1, repeat('a', 64), '95000000-0000-4000-8000-000000000003', 1);
INSERT INTO evaluations (id, organization_id, project_id, slug, name, created_by)
VALUES ('95000000-0000-4000-8000-000000000006', '95000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000002', 'execution-bounds-upgrade', 'Execution Bounds Upgrade', '95000000-0000-4000-8000-000000000003');
INSERT INTO evaluation_definition_versions (id, evaluation_id, organization_id, project_id, version, dataset_version_id, evaluator, target, execution_defaults, thresholds, content_hash, published_by, published_draft_revision)
VALUES ('95000000-0000-4000-8000-000000000007', '95000000-0000-4000-8000-000000000006', '95000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000002', 1, '95000000-0000-4000-8000-000000000005', '{}', '{}', '{}', '{}', repeat('b', 64), '95000000-0000-4000-8000-000000000003', 1);
INSERT INTO evaluation_runs (id, organization_id, project_id, evaluation_id, definition_version_id, dataset_version_id, requested_by_actor_id, status, idempotency_key, request_hash, resolved_inputs_hash)
VALUES ('95000000-0000-4000-8000-000000000008', '95000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000002', '95000000-0000-4000-8000-000000000006', '95000000-0000-4000-8000-000000000007', '95000000-0000-4000-8000-000000000005', '95000000-0000-4000-8000-000000000003', 'running', 'execution-bounds-upgrade', repeat('c', 64), repeat('d', 64));
SELECT set_config('astraea.evaluation_run_admission_run_id', '95000000-0000-4000-8000-000000000008', false);
INSERT INTO evaluation_run_inputs (run_id, organization_id, project_id, target, target_version, target_fingerprint, evaluator, evaluator_version, evaluator_fingerprint, execution_defaults, thresholds, sampling, sample_identity, ordered_item_snapshot, resolved_inputs_hash, limits)
VALUES ('95000000-0000-4000-8000-000000000008', '95000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000002', '{"kind":"configured_llm","provider":"openai","model":"gpt-4o-mini"}', 'configured_llm:v1', repeat('e', 64), '{"kind":"exact_match","version":"v1"}', 'v1', repeat('f', 64), '{}', '{}', '{"strategy":"first_n","sample_size":1,"seed":0}', repeat('1', 64), '[]', repeat('d', 64), '{"max_cost_usd":1,"max_duration_seconds":60}');
