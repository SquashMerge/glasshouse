-- Archival records content-free evidence that in-flight project work was terminalized.
ALTER TABLE project_authorization_audit_events
    DROP CONSTRAINT IF EXISTS project_authorization_audit_events_event_type_check;
ALTER TABLE project_authorization_audit_events
    ADD CONSTRAINT project_authorization_audit_events_event_type_check CHECK (event_type IN (
        'bootstrap_owner_added', 'bootstrap_manager_added', 'organization_membership_created',
        'organization_membership_updated', 'organization_membership_removed',
        'project_created', 'project_updated', 'project_archived', 'project_restored',
        'project_membership_created', 'project_membership_updated', 'project_membership_removed',
        'project_work_cancelled'
    ));
