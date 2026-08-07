INSERT INTO organizations (id, name, slug)
VALUES ('00330000-0000-4000-8000-000000000001', 'Archived Only Organization', 'archived-only');

INSERT INTO organization_memberships (organization_id, actor_subject, role)
VALUES ('00330000-0000-4000-8000-000000000001', 'archived-only-owner', 'owner');

INSERT INTO projects (id, name, slug, organization_id, status, archived_at, archived_by)
VALUES
    (
        '00330000-0000-4000-8000-000000000002',
        'Archived Default Project',
        'default',
        '00330000-0000-4000-8000-000000000001',
        'archived',
        now(),
        'archived-only-owner'
    ),
    (
        '00330000-0000-4000-8000-000000000003',
        'Archived Default Project UUID Suffix',
        'default-00330000000040008000000000000001',
        '00330000-0000-4000-8000-000000000001',
        'archived',
        now(),
        'archived-only-owner'
    ),
    (
        '00330000-0000-4000-8000-000000000004',
        'Archived Default Project Numeric Suffix',
        'default-00330000000040008000000000000001-2',
        '00330000-0000-4000-8000-000000000001',
        'archived',
        now(),
        'archived-only-owner'
    );
