INSERT INTO actors (id) VALUES
    ('74000000-0000-4000-8000-000000000001');

INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES
    ('74000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'basic:v1', 'durable-restore-admin');

INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES
    ('00000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', 'admin');

INSERT INTO projects (id, name, slug, organization_id, status) VALUES
    ('74000000-0000-4000-8000-000000000002', 'Durable restore fixture', 'durable-restore-fixture', '00000000-0000-4000-8000-000000000001', 'archived');
