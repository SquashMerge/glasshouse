INSERT INTO organizations (id, name, slug)
VALUES ('99999999-9999-4999-8999-999999999999', 'Actor Migration', 'actor-migration');

INSERT INTO projects (id, name, slug, organization_id)
VALUES ('99999999-9999-4999-8999-999999999998', 'Actor Project', 'actor-project', '99999999-9999-4999-8999-999999999999');

INSERT INTO organization_memberships (organization_id, actor_subject, role)
VALUES
    ('99999999-9999-4999-8999-999999999999', 'Legacy User', 'owner'),
    ('00000000-0000-4000-8000-000000000001', ' legacy user ', 'member'),
    ('99999999-9999-4999-8999-999999999999', '   ', 'member');
