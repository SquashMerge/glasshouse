-- Apply to a 0097 database, before the additive credential migration.
INSERT INTO actors (id) VALUES
    (durable_actor_id('basic:v1', 'local-upgrade-owner')),
    (durable_actor_id('basic:v1', 'local-upgrade-user'));
INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
SELECT durable_actor_id('basic:v1', subject), '00000000-0000-4000-8000-000000000001', 'basic:v1', subject
FROM unnest(ARRAY['local-upgrade-owner', 'local-upgrade-user']) AS subject;
INSERT INTO organization_memberships (organization_id, actor_subject, role) VALUES
    ('00000000-0000-4000-8000-000000000001', 'local-upgrade-owner', 'owner'),
    ('00000000-0000-4000-8000-000000000001', 'local-upgrade-user', 'member');
INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES
    ('00000000-0000-4000-8000-000000000001', durable_actor_id('basic:v1', 'local-upgrade-owner'), 'admin'),
    ('00000000-0000-4000-8000-000000000001', durable_actor_id('basic:v1', 'local-upgrade-user'), 'user');
INSERT INTO project_memberships (organization_id, project_id, actor_subject, role)
SELECT id, default_project_id, 'local-upgrade-user', 'manager' FROM organizations WHERE slug = 'default';
INSERT INTO project_actor_grants (organization_id, project_id, actor_id, role)
SELECT organization_id, project_id, durable_actor_id('basic:v1', 'local-upgrade-user'), 'user'
FROM project_memberships WHERE actor_subject = 'local-upgrade-user';
SELECT audit_admin_access_event('00000000-0000-4000-8000-000000000001', NULL,
    durable_actor_id('basic:v1', 'local-upgrade-owner'), durable_actor_id('basic:v1', 'local-upgrade-user'), 'organization_role_set');

CREATE TABLE local_upgrade_continuity AS
SELECT 'actors' AS name, jsonb_agg(to_jsonb(t) ORDER BY id) AS rows FROM actors t
UNION ALL SELECT 'identities', jsonb_agg(to_jsonb(t) ORDER BY provider_namespace, canonical_subject) FROM actor_identities t
UNION ALL SELECT 'roles', jsonb_agg(to_jsonb(t) ORDER BY organization_id, actor_id) FROM organization_actor_roles t
UNION ALL SELECT 'grants', jsonb_agg(to_jsonb(t) ORDER BY project_id, actor_id) FROM project_actor_grants t
UNION ALL SELECT 'organization_memberships', jsonb_agg(to_jsonb(t) ORDER BY organization_id, actor_subject) FROM organization_memberships t
UNION ALL SELECT 'project_memberships', jsonb_agg(to_jsonb(t) ORDER BY project_id, actor_subject) FROM project_memberships t
UNION ALL SELECT 'admin_audit', jsonb_agg(to_jsonb(t) ORDER BY id) FROM admin_access_audit_events t
UNION ALL SELECT 'project_audit', jsonb_agg(to_jsonb(t) ORDER BY id) FROM project_authorization_audit_events t;
