BEGIN;

ALTER TABLE organizations ALTER COLUMN default_project_id DROP NOT NULL;

INSERT INTO organizations (id, name, slug)
VALUES ('88888888-8888-4888-8888-888888888888', 'Internal Worker Migration', 'internal-worker-migration');

INSERT INTO projects (id, name, slug, organization_id)
VALUES ('88888888-8888-4888-8888-888888888887', 'Internal Worker Project', 'internal-worker-project', '88888888-8888-4888-8888-888888888888');

UPDATE organizations
SET default_project_id = '88888888-8888-4888-8888-888888888887'
WHERE id = '88888888-8888-4888-8888-888888888888';

ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;

COMMIT;
