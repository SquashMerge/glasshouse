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

INSERT INTO actors (id) VALUES
    ('66666666-6666-4666-8666-666666666601'),
    ('66666666-6666-4666-8666-666666666602'),
    ('66666666-6666-4666-8666-666666666603')
ON CONFLICT DO NOTHING;
INSERT INTO actor_identities (
    actor_id,
    organization_id,
    provider_namespace,
    canonical_subject
) VALUES
    ('66666666-6666-4666-8666-666666666601', '66666666-6666-4666-8666-666666666666', 'basic:v1', 'legacy-admin'),
    ('66666666-6666-4666-8666-666666666602', '66666666-6666-4666-8666-666666666666', 'basic:v1', 'legacy-user'),
    ('66666666-6666-4666-8666-666666666603', '66666666-6666-4666-8666-666666666666', 'basic:v1', 'legacy-reader')
ON CONFLICT DO NOTHING;

INSERT INTO organization_memberships (organization_id, actor_subject, role) VALUES
    ('66666666-6666-4666-8666-666666666666', 'legacy-admin', 'owner'),
    ('66666666-6666-4666-8666-666666666666', 'legacy-user', 'member'),
    ('66666666-6666-4666-8666-666666666666', 'legacy-reader', 'member'),
    ('66666666-6666-4666-8666-666666666666', 'unmapped-legacy-subject', 'member');
INSERT INTO project_memberships (
    project_id,
    organization_id,
    actor_subject,
    role
) VALUES
    ('66666666-6666-4666-8666-666666666665', '66666666-6666-4666-8666-666666666666', 'legacy-user', 'manager'),
    ('66666666-6666-4666-8666-666666666665', '66666666-6666-4666-8666-666666666666', 'legacy-reader', 'member');

ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;

COMMIT;
