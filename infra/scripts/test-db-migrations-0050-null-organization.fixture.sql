INSERT INTO authorization_role_migration_quarantine (
    source_table,
    organization_id,
    project_id,
    actor_subject,
    reason
) VALUES (
    'organization_memberships',
    NULL,
    NULL,
    '0050-preflight-missing-organization',
    'unmapped_legacy_subject'
);
