BEGIN;

ALTER TABLE organizations ALTER COLUMN default_project_id DROP NOT NULL;

INSERT INTO organizations (id, name, slug)
VALUES ('66666666-6666-4666-8666-666666666666', 'Mismatched Internal Worker', 'mismatched-internal-worker');

INSERT INTO projects (id, name, slug, organization_id)
VALUES ('66666666-6666-4666-8666-666666666665', 'Mismatched Internal Worker Project', 'mismatched-internal-worker-project', '66666666-6666-4666-8666-666666666666');

UPDATE organizations
SET default_project_id = '66666666-6666-4666-8666-666666666665'
WHERE id = '66666666-6666-4666-8666-666666666666';

ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;

INSERT INTO actors (id)
VALUES ('55555555-5555-4555-8555-555555555555');

INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
VALUES (
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
    'internal:evaluation-worker:v1',
    '66666666-6666-4666-8666-666666666666'
);

COMMIT;
