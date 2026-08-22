INSERT INTO actors (id) VALUES ('72000000-0000-4000-8000-000000000001');
INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES
    ('72000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'basic:v1', 'legacy-execution-user');
INSERT INTO projects (id, name, slug, organization_id, status) VALUES
    ('72000000-0000-4000-8000-000000000002', 'Legacy execution fixture', 'legacy-execution-fixture', '00000000-0000-4000-8000-000000000001', 'active');
INSERT INTO datasets (id, project_id, slug, name, latest_published_version) VALUES
    ('72000000-0000-4000-8000-000000000003', '72000000-0000-4000-8000-000000000002', 'legacy-execution-dataset', 'Legacy execution dataset', 1);
INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash) VALUES
    ('72000000-0000-4000-8000-000000000004', '72000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000003', 1, 1, repeat('a', 64));
INSERT INTO dataset_version_items (id, project_id, dataset_version_id, item_key, position, input) VALUES
    ('72000000-0000-4000-8000-000000000005', '72000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000004', 'legacy-case', 0, '{"input":"legacy"}');
INSERT INTO experiments (id, project_id, dataset_id, name, status, requested_by_actor_id) VALUES
    ('72000000-0000-4000-8000-000000000006', '72000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000003', 'Legacy execution', 'running', '72000000-0000-4000-8000-000000000001');
INSERT INTO execution_admissions (id, organization_id, project_id, requester_actor_id, work_kind, work_id, authorization_epoch, expires_at)
SELECT
    '72000000-0000-4000-8000-000000000007',
    '00000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    'experiment_task',
    task.id,
    1,
    now() + interval '1 hour'
FROM experiment_tasks task
WHERE task.experiment_id = '72000000-0000-4000-8000-000000000006';
