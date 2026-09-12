-- A populated pre-0090/0091 Evaluation Run with one safely repairable task.
WITH organization AS (
    INSERT INTO organizations (id, name, slug, default_project_id)
    VALUES ('90000000-0000-4000-8000-000000000001', 'Introspection Upgrade', 'introspection-upgrade', '90000000-0000-4000-8000-000000000002')
    RETURNING id
)
INSERT INTO projects (id, organization_id, name, slug)
SELECT '90000000-0000-4000-8000-000000000002', id, 'Default Project', 'default'
FROM organization;

INSERT INTO actors (id) VALUES ('90000000-0000-4000-8000-000000000003');
INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
VALUES ('90000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000001', 'basic:v1', 'introspection-upgrade');
INSERT INTO organization_actor_roles (organization_id, actor_id, role)
VALUES ('90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000003', 'user');
INSERT INTO project_actor_grants (project_id, organization_id, actor_id, role)
VALUES ('90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000003', 'user');

INSERT INTO agents (id, project_id, name)
VALUES ('90000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000002', 'Upgrade agent');
INSERT INTO datasets (id, project_id, name, slug)
VALUES ('90000000-0000-4000-8000-000000000005', '90000000-0000-4000-8000-000000000002', 'Upgrade dataset', 'upgrade-dataset');
INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash, published_by, published_draft_revision)
VALUES ('90000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000005', 1, 3, repeat('a', 64), '90000000-0000-4000-8000-000000000003', 1);
INSERT INTO dataset_version_items (id, project_id, dataset_version_id, item_key, position, input)
VALUES
    ('90000000-0000-4000-8000-000000000007', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000006', 'upgrade-item-a', 0, '{"input":"upgrade-a"}'),
    ('90000000-0000-4000-8000-000000000018', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000006', 'upgrade-item-b', 1, '{"input":"upgrade-b"}'),
    ('90000000-0000-4000-8000-000000000021', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000006', 'upgrade-item-c', 2, '{"input":"upgrade-c"}');
INSERT INTO evaluations (id, organization_id, project_id, slug, name, created_by)
VALUES ('90000000-0000-4000-8000-000000000008', '90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', 'upgrade-evaluation', 'Upgrade evaluation', '90000000-0000-4000-8000-000000000003');
INSERT INTO evaluation_definition_versions (id, evaluation_id, organization_id, project_id, version, dataset_version_id, evaluator, target, execution_defaults, thresholds, content_hash, published_by, published_draft_revision)
VALUES ('90000000-0000-4000-8000-000000000009', '90000000-0000-4000-8000-000000000008', '90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', 1, '90000000-0000-4000-8000-000000000006', '{}', '{}', '{}', '{}', repeat('b', 64), '90000000-0000-4000-8000-000000000003', 1);
INSERT INTO evaluation_runs (id, organization_id, project_id, evaluation_id, definition_version_id, dataset_version_id, requested_by_actor_id, idempotency_key, request_hash, resolved_inputs_hash)
VALUES
    ('90000000-0000-4000-8000-000000000010', '90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000008', '90000000-0000-4000-8000-000000000009', '90000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-000000000003', 'upgrade-run-one', repeat('c', 64), repeat('d', 64)),
    ('90000000-0000-4000-8000-000000000011', '90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000008', '90000000-0000-4000-8000-000000000009', '90000000-0000-4000-8000-000000000006', '90000000-0000-4000-8000-000000000003', 'upgrade-run-two', repeat('e', 64), repeat('f', 64));
SELECT set_config('astraea.evaluation_run_admission_run_id', '90000000-0000-4000-8000-000000000010', false);
INSERT INTO evaluation_run_items (id, organization_id, project_id, run_id, dataset_version_item_id, position, item_key, input)
VALUES
    ('90000000-0000-4000-8000-000000000012', '90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000010', '90000000-0000-4000-8000-000000000007', 0, 'upgrade-item-a', '{"input":"upgrade-a"}'),
    ('90000000-0000-4000-8000-000000000019', '90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000010', '90000000-0000-4000-8000-000000000018', 1, 'upgrade-item-b', '{"input":"upgrade-b"}'),
    ('90000000-0000-4000-8000-000000000022', '90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000010', '90000000-0000-4000-8000-000000000021', 2, 'upgrade-item-c', '{"input":"upgrade-c"}');
SELECT set_config('astraea.evaluation_run_admission_run_id', '90000000-0000-4000-8000-000000000011', false);
INSERT INTO evaluation_run_items (id, organization_id, project_id, run_id, dataset_version_item_id, position, item_key, input)
VALUES ('90000000-0000-4000-8000-000000000013', '90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000011', '90000000-0000-4000-8000-000000000007', 0, 'upgrade-item-a', '{"input":"upgrade-a"}');

INSERT INTO experiments (id, project_id, agent_id, dataset_id, status, config, requested_by_actor_id, evaluation_run_id, resolved_dataset_version_id, dataset_input_binding)
VALUES ('90000000-0000-4000-8000-000000000014', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000005', 'pending', '{}', '90000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000010', '90000000-0000-4000-8000-000000000006', 'versioned');

-- Task A is from Run one but points to Run two. Its deterministic target is
-- occupied by task B, whose own Run-item/Dataset-version-item link is invalid.
-- 0091 would otherwise abort on its unique Run-item index before 0092 can help.
UPDATE experiment_tasks
SET evaluation_run_item_id = '90000000-0000-4000-8000-000000000013'
WHERE experiment_id = '90000000-0000-4000-8000-000000000014'
  AND dataset_version_item_id = '90000000-0000-4000-8000-000000000007';
UPDATE experiment_tasks
SET evaluation_run_item_id = '90000000-0000-4000-8000-000000000012'
WHERE experiment_id = '90000000-0000-4000-8000-000000000014'
  AND dataset_version_item_id = '90000000-0000-4000-8000-000000000018';
INSERT INTO experiment_results (id, experiment_id, project_id, dataset_version_item_id, evaluation_run_id, evaluation_run_item_id, output, scores, status)
VALUES
    ('90000000-0000-4000-8000-000000000015', '90000000-0000-4000-8000-000000000014', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000007', '90000000-0000-4000-8000-000000000010', '90000000-0000-4000-8000-000000000013', '{"output":"collision-preserved"}', '{"score":1}', 'completed'),
    ('90000000-0000-4000-8000-000000000020', '90000000-0000-4000-8000-000000000014', '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000018', '90000000-0000-4000-8000-000000000010', '90000000-0000-4000-8000-000000000012', '{"output":"misassociation-preserved"}', '{"score":1}', 'completed');
