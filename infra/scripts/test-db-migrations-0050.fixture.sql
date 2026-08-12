INSERT INTO authorization_role_migration_audit (
    source_table,
    organization_id,
    project_id,
    actor_subject,
    legacy_role,
    effective_role
) VALUES (
    'organization_memberships',
    '00000000-0000-4000-8000-000000000001',
    NULL,
    '0050-organization-audit',
    'owner',
    'admin'
);

INSERT INTO authorization_role_migration_quarantine (
    source_table,
    organization_id,
    project_id,
    actor_subject,
    reason
) VALUES (
    'organization_memberships',
    '00000000-0000-4000-8000-000000000001',
    NULL,
    '0050-organization-quarantine',
    'unmapped_legacy_subject'
);
