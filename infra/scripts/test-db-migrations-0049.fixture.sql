WITH organization AS (
    INSERT INTO organizations (id, name, slug, default_project_id)
    VALUES (
        '49000000-0000-4000-8000-000000000001',
        'Cancellation Identity Repair',
        'cancellation-identity-repair',
        '49000000-0000-4000-8000-000000000002'
    )
    RETURNING id
)
INSERT INTO projects (id, organization_id, name, slug)
SELECT '49000000-0000-4000-8000-000000000002', id, 'Default Project', 'default'
FROM organization;

INSERT INTO projects (id, organization_id, name, slug)
VALUES (
    '49000000-0000-4000-8000-000000000003',
    '49000000-0000-4000-8000-000000000001',
    'Cancellation Identity Repair',
    'cancellation-identity-repair'
);

INSERT INTO actors (id) VALUES ('49000000-0000-4000-8000-000000000004');
INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
VALUES (
    '49000000-0000-4000-8000-000000000004',
    '49000000-0000-4000-8000-000000000001',
    'basic:v1',
    'cancellation-matched-user'
);

INSERT INTO organization_memberships (organization_id, actor_subject, role)
VALUES
    ('49000000-0000-4000-8000-000000000001', 'cancellation-matched-user', 'member'),
    ('49000000-0000-4000-8000-000000000001', 'cancellation-unmapped-user', 'member');
INSERT INTO project_memberships (project_id, organization_id, actor_subject, role)
VALUES
    ('49000000-0000-4000-8000-000000000003', '49000000-0000-4000-8000-000000000001', 'cancellation-matched-user', 'manager'),
    ('49000000-0000-4000-8000-000000000003', '49000000-0000-4000-8000-000000000001', 'cancellation-unmapped-user', 'manager');

INSERT INTO prompts (id, project_id, name, slug)
VALUES (
    '49000000-0000-4000-8000-000000000005',
    '49000000-0000-4000-8000-000000000003',
    'Cancellation Identity Prompt',
    'cancellation-identity'
);

INSERT INTO prompt_optimization_jobs (
    id, project_id, prompt_id, prompt_slug, source_version, target_role,
    source_messages, evaluator, examples, dataset, dataset_hash, model_config,
    budget, status, requested_by
) VALUES (
    '49000000-0000-4000-8000-000000000006',
    '49000000-0000-4000-8000-000000000003',
    '49000000-0000-4000-8000-000000000005',
    'cancellation-identity',
    1,
    'system',
    '[{"role":"system","content":"Summarize"}]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    '{"version":1,"rubric":"cancellation","training_examples":[{"input":"one","answer":"one"}],"validation_examples":[{"input":"two","answer":"two"}]}'::jsonb,
    repeat('a', 64),
    '{}'::jsonb,
    '{}'::jsonb,
    'optimizing',
    'cancellation-matched-user'
);

INSERT INTO execution_admissions (
    id, organization_id, project_id, requester_actor_id, work_kind, work_id,
    authorization_epoch, expires_at
) VALUES (
    '49000000-0000-4000-8000-000000000007',
    '49000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000003',
    '49000000-0000-4000-8000-000000000004',
    'optimization',
    '49000000-0000-4000-8000-000000000006',
    1,
    now() + interval '1 minute'
);
