INSERT INTO execution_admissions (
    id, organization_id, project_id, requester_actor_id, work_kind, work_id,
    authorization_epoch, expires_at
) VALUES (
    '46000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000002',
    '44000000-0000-4000-8000-000000000003',
    'experiment_task',
    '46000000-0000-4000-8000-000000000002',
    1,
    now() + interval '1 minute'
);

INSERT INTO execution_admission_claims (
    id, admission_id, effect, authorization_epoch, expires_at
) VALUES (
    '46000000-0000-4000-8000-000000000003',
    '46000000-0000-4000-8000-000000000001',
    'provider_dispatch',
    1,
    now() + interval '1 minute'
);
