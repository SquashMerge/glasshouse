INSERT INTO organizations (id, name, slug, default_project_id) VALUES
    ('51000000-0000-4000-8000-000000000001', 'Admin fixture', 'admin-fixture', '51000000-0000-4000-8000-000000000010'),
    ('51000000-0000-4000-8000-000000000002', 'Other fixture', 'other-fixture', '51000000-0000-4000-8000-000000000020');
INSERT INTO projects (id, organization_id, name, slug) VALUES
    ('51000000-0000-4000-8000-000000000010', '51000000-0000-4000-8000-000000000001', 'Admin default', 'default'),
    ('51000000-0000-4000-8000-000000000011', '51000000-0000-4000-8000-000000000001', 'Admin active', 'active'),
    ('51000000-0000-4000-8000-000000000020', '51000000-0000-4000-8000-000000000002', 'Other default', 'default');
INSERT INTO actors (id) VALUES
    ('51000000-0000-4000-8000-000000000101'),
    ('51000000-0000-4000-8000-000000000102'),
    ('51000000-0000-4000-8000-000000000103'),
    ('51000000-0000-4000-8000-000000000104');
INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES
    ('51000000-0000-4000-8000-000000000101', '51000000-0000-4000-8000-000000000001', 'basic:v1', 'admin-fixture-owner'),
    ('51000000-0000-4000-8000-000000000102', '51000000-0000-4000-8000-000000000001', 'basic:v1', 'admin-fixture-reader'),
    ('51000000-0000-4000-8000-000000000103', '51000000-0000-4000-8000-000000000002', 'basic:v1', 'other-fixture-reader'),
    ('51000000-0000-4000-8000-000000000104', '51000000-0000-4000-8000-000000000001', 'internal:evaluation-worker:v1', '51000000-0000-4000-8000-000000000001');
INSERT INTO organization_memberships (organization_id, actor_subject, role) VALUES
    ('51000000-0000-4000-8000-000000000001', 'admin-fixture-owner', 'owner'),
    ('51000000-0000-4000-8000-000000000001', 'admin-fixture-reader', 'member'),
    ('51000000-0000-4000-8000-000000000002', 'other-fixture-reader', 'member');
INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) VALUES
    ('51000000-0000-4000-8000-000000000011', '51000000-0000-4000-8000-000000000001', 'admin-fixture-reader', 'member');
