INSERT INTO organizations (id, name, slug)
VALUES ('00000000-0000-4000-8000-000000000028', 'Audit Repair Organization', 'audit-repair');

INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type)
VALUES (
    '00000000-0000-4000-8000-000000000028',
    NULL,
    'migration-audit-repair',
    'organization_membership_created'
);
