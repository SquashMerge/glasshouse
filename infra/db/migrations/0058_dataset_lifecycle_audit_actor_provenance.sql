-- Lifecycle evidence records the actor's durable organization provenance.
ALTER TABLE dataset_lifecycle_audit_events
    ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE dataset_lifecycle_audit_events AS event
SET organization_id = project.organization_id
FROM projects AS project
WHERE project.id = event.project_id
  AND event.organization_id IS NULL;

ALTER TABLE dataset_lifecycle_audit_events
    ALTER COLUMN organization_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS projects_organization_id_id_key
    ON projects (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS actor_identities_organization_id_actor_id_key
    ON actor_identities (organization_id, actor_id);

ALTER TABLE dataset_lifecycle_audit_events
    ADD CONSTRAINT dataset_lifecycle_audit_events_project_scope_fkey
    FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id)
    ON DELETE RESTRICT,
    ADD CONSTRAINT dataset_lifecycle_audit_events_actor_scope_fkey
    FOREIGN KEY (organization_id, actor_id)
    REFERENCES actor_identities(organization_id, actor_id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION require_dataset_lifecycle_audit_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM datasets
        WHERE id = NEW.dataset_id
          AND project_id = NEW.project_id
    ) THEN
        RAISE EXCEPTION 'dataset lifecycle audit provenance is invalid' USING ERRCODE = '23503';
    END IF;
    IF NOT authorization_allows_project(
        NEW.organization_id,
        NEW.project_id,
        NEW.actor_id,
        CASE WHEN NEW.event_type = 'archived' THEN 'destructive' ELSE 'product_write' END
    ) THEN
        RAISE EXCEPTION 'dataset lifecycle audit actor is not authorized' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END
$$;
