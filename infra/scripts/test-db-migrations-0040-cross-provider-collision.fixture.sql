BEGIN;

ALTER TABLE organizations ALTER COLUMN default_project_id DROP NOT NULL;

INSERT INTO organizations (id, name, slug)
VALUES ('44444444-4444-4444-8444-444444444444', 'Cross Provider Actor Collision', 'cross-provider-actor-collision');

INSERT INTO projects (id, name, slug, organization_id)
VALUES ('44444444-4444-4444-8444-444444444443', 'Cross Provider Collision Project', 'cross-provider-collision-project', '44444444-4444-4444-8444-444444444444');

UPDATE organizations
SET default_project_id = '44444444-4444-4444-8444-444444444443'
WHERE id = '44444444-4444-4444-8444-444444444444';

ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;

INSERT INTO actors (id)
VALUES (durable_actor_id('internal:evaluation-worker:v1', '44444444-4444-4444-8444-444444444444'));

INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
VALUES (
    durable_actor_id('internal:evaluation-worker:v1', '44444444-4444-4444-8444-444444444444'),
    '44444444-4444-4444-8444-444444444444',
    'basic:v1',
    'cross-provider-collision'
);

COMMIT;
