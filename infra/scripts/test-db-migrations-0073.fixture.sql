INSERT INTO actors (id) VALUES ('73000000-0000-4000-8000-000000000001');
INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES
    ('73000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'basic:v1', 'lifecycle-governance-user');
INSERT INTO projects (id, name, slug, organization_id, status) VALUES
    ('73000000-0000-4000-8000-000000000002', 'Lifecycle governance fixture', 'lifecycle-governance-fixture', '00000000-0000-4000-8000-000000000001', 'active');
INSERT INTO datasets (id, project_id, slug, name, archived_at) VALUES
    ('73000000-0000-4000-8000-000000000003', '73000000-0000-4000-8000-000000000002', 'held-dataset', 'Held dataset', now());
