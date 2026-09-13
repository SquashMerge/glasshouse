-- A legacy upgrade can contain a Run-only task whose deterministic target is
-- occupied by another task. Startup must fail closed without a guessed remap.
WITH organization AS (
    INSERT INTO organizations (id, name, slug, default_project_id)
    VALUES ('91000000-0000-4000-8000-000000000001', 'Post 0091 Upgrade', 'post-0091-upgrade', '91000000-0000-4000-8000-000000000002')
    RETURNING id
)
INSERT INTO projects (id, organization_id, name, slug)
SELECT '91000000-0000-4000-8000-000000000002', id, 'Default Project', 'default'
FROM organization;

INSERT INTO actors (id) VALUES ('91000000-0000-4000-8000-000000000003');
INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
VALUES ('91000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000001', 'basic:v1', 'post-0091-upgrade');
INSERT INTO organization_actor_roles (organization_id, actor_id, role)
VALUES ('91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000003', 'user');
INSERT INTO project_actor_grants (project_id, organization_id, actor_id, role)
VALUES ('91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000003', 'user');

INSERT INTO agents (id, project_id, name)
VALUES ('91000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-000000000002', 'Post 0091 agent');
INSERT INTO datasets (id, project_id, name, slug)
VALUES ('91000000-0000-4000-8000-000000000005', '91000000-0000-4000-8000-000000000002', 'Post 0091 dataset', 'post-0091-dataset');
INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash, published_by, published_draft_revision)
VALUES ('91000000-0000-4000-8000-000000000006', '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000005', 1, 1, repeat('a', 64), '91000000-0000-4000-8000-000000000003', 1);
INSERT INTO dataset_version_items (id, project_id, dataset_version_id, item_key, position, input)
VALUES ('91000000-0000-4000-8000-000000000007', '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000006', 'post-0091-item', 0, '{"input":"post-0091"}');
INSERT INTO evaluations (id, organization_id, project_id, slug, name, created_by)
VALUES ('91000000-0000-4000-8000-000000000008', '91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', 'post-0091-evaluation', 'Post 0091 evaluation', '91000000-0000-4000-8000-000000000003');
INSERT INTO evaluation_definition_versions (id, evaluation_id, organization_id, project_id, version, dataset_version_id, evaluator, target, execution_defaults, thresholds, content_hash, published_by, published_draft_revision)
VALUES ('91000000-0000-4000-8000-000000000009', '91000000-0000-4000-8000-000000000008', '91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', 1, '91000000-0000-4000-8000-000000000006', '{}', '{}', '{}', '{}', repeat('b', 64), '91000000-0000-4000-8000-000000000003', 1);
INSERT INTO evaluation_runs (id, organization_id, project_id, evaluation_id, definition_version_id, dataset_version_id, requested_by_actor_id, idempotency_key, request_hash, resolved_inputs_hash)
VALUES ('91000000-0000-4000-8000-000000000010', '91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000008', '91000000-0000-4000-8000-000000000009', '91000000-0000-4000-8000-000000000006', '91000000-0000-4000-8000-000000000003', 'post-0091-run', repeat('c', 64), repeat('d', 64));
SELECT set_config('astraea.evaluation_run_admission_run_id', '91000000-0000-4000-8000-000000000010', false);
INSERT INTO evaluation_run_items (id, organization_id, project_id, run_id, dataset_version_item_id, position, item_key, input)
VALUES ('91000000-0000-4000-8000-000000000011', '91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000010', '91000000-0000-4000-8000-000000000007', 0, 'post-0091-item', '{"input":"post-0091"}');

INSERT INTO experiments (id, project_id, agent_id, dataset_id, status, config, requested_by_actor_id, resolved_dataset_version_id, dataset_input_binding)
VALUES
    ('91000000-0000-4000-8000-000000000012', '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-000000000005', 'pending', '{}', '91000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000006', 'versioned'),
    ('91000000-0000-4000-8000-000000000013', '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-000000000005', 'pending', '{}', '91000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000006', 'versioned');
UPDATE experiment_tasks
SET evaluation_run_id = '91000000-0000-4000-8000-000000000010',
    evaluation_run_item_id = '91000000-0000-4000-8000-000000000011'
WHERE experiment_id = '91000000-0000-4000-8000-000000000012'
  AND dataset_version_item_id = '91000000-0000-4000-8000-000000000007';
UPDATE experiment_tasks
SET evaluation_run_id = '91000000-0000-4000-8000-000000000010',
    evaluation_run_item_id = NULL
WHERE experiment_id = '91000000-0000-4000-8000-000000000013'
  AND dataset_version_item_id = '91000000-0000-4000-8000-000000000007';
