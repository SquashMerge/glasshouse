BEGIN;

ALTER TABLE organizations ALTER COLUMN default_project_id DROP NOT NULL;

INSERT INTO organizations (id, name, slug)
VALUES (
    '66666666-6666-4666-8666-666666666666',
    'Admin User Read Only Migration',
    'admin-user-read-only-migration'
);
INSERT INTO projects (id, name, slug, organization_id)
VALUES (
    '66666666-6666-4666-8666-666666666665',
    'Admin User Read Only Project',
    'admin-user-read-only-project',
    '66666666-6666-4666-8666-666666666666'
);
UPDATE organizations
SET default_project_id = '66666666-6666-4666-8666-666666666665'
WHERE id = '66666666-6666-4666-8666-666666666666';

INSERT INTO actors (id)
VALUES ('66666666-6666-4666-8666-666666666601')
ON CONFLICT DO NOTHING;
INSERT INTO actor_identities (
    actor_id,
    organization_id,
    provider_namespace,
    canonical_subject
) VALUES (
    '66666666-6666-4666-8666-666666666601',
    '66666666-6666-4666-8666-666666666666',
    'basic:v1',
    'legacy-admin'
)
ON CONFLICT DO NOTHING;

ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;

INSERT INTO datasets (id, project_id, name)
VALUES (
    '66666666-6666-4666-8666-666666666620',
    '66666666-6666-4666-8666-666666666665',
    'Requester authorization dataset'
);
INSERT INTO dataset_items (id, dataset_id, input, expected_output)
VALUES (
    '66666666-6666-4666-8666-666666666621',
    '66666666-6666-4666-8666-666666666620',
    '{"question":"one"}',
    '{"value":"one"}'
);
INSERT INTO experiments (id, project_id, agent_id, dataset_id, name, config, status)
VALUES (
    '66666666-6666-4666-8666-666666666622',
    '66666666-6666-4666-8666-666666666665',
    NULL,
    '66666666-6666-4666-8666-666666666620',
    'Historical unbound experiment',
    '{}',
    'pending'
);

COMMIT;
