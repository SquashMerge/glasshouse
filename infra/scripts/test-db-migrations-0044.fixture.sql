WITH organization AS (
    INSERT INTO organizations (id, name, slug, default_project_id)
    VALUES (
        '44000000-0000-4000-8000-000000000001',
        'Admission Replay',
        'admission-replay',
        '44000000-0000-4000-8000-000000000012'
    )
    RETURNING id
)
INSERT INTO projects (id, organization_id, name, slug)
SELECT '44000000-0000-4000-8000-000000000012', id, 'Default Project', 'default'
FROM organization;
INSERT INTO actors (id) VALUES ('44000000-0000-4000-8000-000000000003');
INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
VALUES (
    '44000000-0000-4000-8000-000000000003',
    '44000000-0000-4000-8000-000000000001',
    'basic:v1',
    'admission-replay-user'
);
INSERT INTO organization_memberships (organization_id, actor_subject, role)
VALUES ('44000000-0000-4000-8000-000000000001', 'admission-replay-user', 'member');
INSERT INTO organization_memberships (organization_id, actor_subject, role)
VALUES ('44000000-0000-4000-8000-000000000001', 'admission-replay-other', 'member');
INSERT INTO projects (id, organization_id, name, slug)
VALUES (
    '44000000-0000-4000-8000-000000000002',
    '44000000-0000-4000-8000-000000000001',
    'Admission Replay',
    'admission-replay'
);
INSERT INTO project_memberships (project_id, organization_id, actor_subject, role)
VALUES (
    '44000000-0000-4000-8000-000000000002',
    '44000000-0000-4000-8000-000000000001',
    'admission-replay-user',
    'manager'
);
INSERT INTO project_memberships (project_id, organization_id, actor_subject, role)
VALUES (
    '44000000-0000-4000-8000-000000000002',
    '44000000-0000-4000-8000-000000000001',
    'admission-replay-other',
    'manager'
);
INSERT INTO datasets (id, project_id, name)
VALUES ('44000000-0000-4000-8000-000000000004', '44000000-0000-4000-8000-000000000002', 'Admission Replay Dataset');
INSERT INTO dataset_items (id, dataset_id, input, expected_output)
VALUES (
    '44000000-0000-4000-8000-000000000005',
    '44000000-0000-4000-8000-000000000004',
    '{"input":"replay"}'::jsonb,
    '{"output":"replay"}'::jsonb
);
INSERT INTO experiments (id, project_id, dataset_id, config, status, requested_by_actor_id)
VALUES (
    '44000000-0000-4000-8000-000000000006',
    '44000000-0000-4000-8000-000000000002',
    '44000000-0000-4000-8000-000000000004',
    '{}'::jsonb,
    'running',
    '44000000-0000-4000-8000-000000000003'
);
INSERT INTO prompts (id, project_id, name, slug)
VALUES (
    '44000000-0000-4000-8000-000000000007',
    '44000000-0000-4000-8000-000000000002',
    'Admission Replay Prompt',
    'admission-replay'
);
INSERT INTO prompt_optimization_jobs (
    id, project_id, prompt_id, prompt_slug, source_version, target_role,
    source_messages, evaluator, examples, dataset, dataset_hash, model_config,
    budget, status, requested_by
) VALUES (
    '44000000-0000-4000-8000-000000000008',
    '44000000-0000-4000-8000-000000000002',
    '44000000-0000-4000-8000-000000000007',
    'admission-replay',
    1,
    'system',
    '[{"role":"system","content":"Summarize"}]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    '{"version":1,"rubric":"replay","training_examples":[{"input":"one","answer":"one"}],"validation_examples":[{"input":"two","answer":"two"}]}'::jsonb,
    repeat('a', 64),
    '{}'::jsonb,
    '{}'::jsonb,
    'optimizing',
    'admission-replay-user'
);
