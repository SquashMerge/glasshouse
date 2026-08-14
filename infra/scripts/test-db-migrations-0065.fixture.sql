INSERT INTO datasets (id, project_id, slug, name, latest_published_version)
VALUES
    ('65000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'feedback-identity-a', 'Feedback identity A', 1),
    ('65000000-0000-4000-8000-000000000002', '11111111-1111-1111-1111-111111111111', 'feedback-identity-b', 'Feedback identity B', 1);

INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash)
VALUES
    ('65000000-0000-4000-8000-000000000011', '11111111-1111-1111-1111-111111111111', '65000000-0000-4000-8000-000000000001', 1, 1, repeat('a', 64)),
    ('65000000-0000-4000-8000-000000000012', '11111111-1111-1111-1111-111111111111', '65000000-0000-4000-8000-000000000002', 1, 1, repeat('b', 64));

INSERT INTO dataset_version_items (id, project_id, dataset_version_id, item_key, position, input)
VALUES
    ('65000000-0000-4000-8000-000000000021', '11111111-1111-1111-1111-111111111111', '65000000-0000-4000-8000-000000000011', 'feedback-identity-a', 0, '{}'::jsonb),
    ('65000000-0000-4000-8000-000000000022', '11111111-1111-1111-1111-111111111111', '65000000-0000-4000-8000-000000000012', 'feedback-identity-b', 0, '{}'::jsonb);

INSERT INTO dataset_drafts (id, project_id, dataset_id, base_version, created_by)
VALUES ('65000000-0000-4000-8000-000000000031', '11111111-1111-1111-1111-111111111111', '65000000-0000-4000-8000-000000000002', 1, durable_actor_id('basic:v1', 'bootstrap-owner'));

INSERT INTO dataset_draft_items (id, project_id, draft_id, item_key, position, input)
VALUES ('65000000-0000-4000-8000-000000000032', '11111111-1111-1111-1111-111111111111', '65000000-0000-4000-8000-000000000031', 'feedback-identity-draft-b', 0, '{}'::jsonb);

INSERT INTO scores (id, project_id, trace_id, name, value, metadata)
VALUES
    ('65000000-0000-4000-8000-000000000041', '11111111-1111-1111-1111-111111111111', 'feedback-identity-snapshot', 'human.feedback', -1, '{}'::jsonb),
    ('65000000-0000-4000-8000-000000000042', '11111111-1111-1111-1111-111111111111', 'feedback-identity-draft', 'human.feedback', -1, '{}'::jsonb);
