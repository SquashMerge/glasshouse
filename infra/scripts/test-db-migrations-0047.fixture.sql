INSERT INTO execution_admissions (
    id, organization_id, project_id, requester_actor_id, work_kind, work_id,
    authorization_epoch, expires_at
) VALUES (
    '47000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000002',
    '44000000-0000-4000-8000-000000000003',
    'experiment_task',
    '46000000-0000-4000-8000-000000000002',
    1,
    now() + interval '1 minute'
);

INSERT INTO execution_admission_claims (
    id, admission_id, effect, effect_key, authorization_epoch, expires_at
) VALUES (
    '47000000-0000-4000-8000-000000000002',
    '47000000-0000-4000-8000-000000000001',
    'provider_dispatch',
    '46000000-0000-4000-8000-000000000003',
    1,
    now() + interval '1 minute'
);

INSERT INTO organizations (id, name, slug)
VALUES (
    '47000000-0000-4000-8000-000000000003',
    'Cross-Tenant Admission Replay',
    'cross-tenant-admission-replay'
);
INSERT INTO actors (id) VALUES ('47000000-0000-4000-8000-000000000004');
INSERT INTO projects (id, organization_id, name, slug)
VALUES (
    '47000000-0000-4000-8000-000000000005',
    '47000000-0000-4000-8000-000000000003',
    'Cross-Tenant Admission Replay',
    'cross-tenant-admission-replay'
);
INSERT INTO execution_admissions (
    id, organization_id, project_id, requester_actor_id, work_kind, work_id,
    authorization_epoch, expires_at
) VALUES (
    '47000000-0000-4000-8000-000000000006',
    '47000000-0000-4000-8000-000000000003',
    '47000000-0000-4000-8000-000000000005',
    '47000000-0000-4000-8000-000000000004',
    'experiment_task',
    '46000000-0000-4000-8000-000000000002',
    1,
    now() + interval '1 minute'
);
INSERT INTO execution_admission_claims (
    id, admission_id, effect, effect_key, authorization_epoch, expires_at
) VALUES (
    '47000000-0000-4000-8000-000000000007',
    '47000000-0000-4000-8000-000000000006',
    'provider_dispatch',
    '46000000-0000-4000-8000-000000000003',
    1,
    now() + interval '1 minute'
);
