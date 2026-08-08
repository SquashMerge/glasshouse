-- Basic Auth remains a compatibility provider. Its normalized subject is stable
-- while legacy membership and audit subjects remain immutable historical data.
CREATE TABLE IF NOT EXISTS actors (
    id UUID PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS actor_identities (
    actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    provider_namespace TEXT NOT NULL,
    canonical_subject TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider_namespace, canonical_subject),
    UNIQUE (actor_id, provider_namespace),
    UNIQUE (organization_id, provider_namespace, canonical_subject)
);

CREATE TABLE IF NOT EXISTS actor_identity_backfill_quarantine (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_table TEXT NOT NULL,
    organization_id UUID,
    legacy_subject TEXT NOT NULL,
    reason TEXT NOT NULL,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_table, organization_id, legacy_subject, reason)
);

CREATE OR REPLACE FUNCTION basic_auth_canonical_subject(subject TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    normalized TEXT;
BEGIN
    normalized := lower(btrim(normalize(subject, 'NFKC')));
    IF normalized = '' OR normalized !~ '^[ -~]+$' THEN
        RAISE EXCEPTION 'Basic Auth subject must normalize to printable ASCII';
    END IF;
    RETURN normalized;
END
$$;

CREATE OR REPLACE FUNCTION basic_auth_identity_matches(
    identity_organization_id UUID,
    legacy_subject TEXT,
    identity_actor_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
        WHEN btrim(legacy_subject) = ''
          OR normalize(legacy_subject, 'NFKC') !~ '^[ -~]+$' THEN false
        ELSE EXISTS (
            SELECT 1
            FROM actor_identities identity
            WHERE identity.organization_id = identity_organization_id
              AND identity.actor_id = identity_actor_id
              AND identity.provider_namespace = 'basic:v1'
              AND identity.canonical_subject = basic_auth_canonical_subject(legacy_subject)
        )
    END
$$;

CREATE OR REPLACE FUNCTION durable_actor_id(provider TEXT, subject TEXT)
RETURNS UUID
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT (
        substr(md5(provider || ':' || subject), 1, 8) || '-' ||
        substr(md5(provider || ':' || subject), 9, 4) || '-5' ||
        substr(md5(provider || ':' || subject), 14, 3) || '-8' ||
        substr(md5(provider || ':' || subject), 18, 3) || '-' ||
        substr(md5(provider || ':' || subject), 21, 12)
    )::uuid
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM actor_identities
        WHERE provider_namespace = 'basic:v1'
          AND actor_id <> durable_actor_id(provider_namespace, canonical_subject)
    ) THEN
        RAISE EXCEPTION 'existing Basic Auth identity is linked to a non-canonical actor';
    END IF;
END
$$;

WITH candidates AS (
    SELECT organization_id, actor_subject AS legacy_subject
    FROM organization_memberships
), invalid AS (
    SELECT organization_id, legacy_subject, 'malformed_subject' AS reason
    FROM candidates
    WHERE btrim(legacy_subject) = ''
       OR normalize(legacy_subject, 'NFKC') !~ '^[ -~]+$'
), collisions AS (
    SELECT candidate.organization_id, candidate.legacy_subject, 'canonical_subject_collision' AS reason
    FROM candidates candidate
    JOIN (
        SELECT basic_auth_canonical_subject(legacy_subject) AS canonical_subject
        FROM candidates
        WHERE btrim(legacy_subject) <> ''
          AND normalize(legacy_subject, 'NFKC') ~ '^[ -~]+$'
        GROUP BY basic_auth_canonical_subject(legacy_subject)
        HAVING count(DISTINCT legacy_subject) > 1
    ) collided ON basic_auth_canonical_subject(candidate.legacy_subject) = collided.canonical_subject
    WHERE btrim(candidate.legacy_subject) <> ''
       AND normalize(candidate.legacy_subject, 'NFKC') ~ '^[ -~]+$'
), cross_organization AS (
    SELECT candidate.organization_id, candidate.legacy_subject, 'cross_organization_subject' AS reason
    FROM candidates candidate
    JOIN (
        SELECT basic_auth_canonical_subject(legacy_subject) AS canonical_subject
        FROM candidates
        WHERE btrim(legacy_subject) <> ''
          AND normalize(legacy_subject, 'NFKC') ~ '^[ -~]+$'
        GROUP BY basic_auth_canonical_subject(legacy_subject)
        HAVING count(DISTINCT organization_id) > 1
    ) collided ON basic_auth_canonical_subject(candidate.legacy_subject) = collided.canonical_subject
    WHERE btrim(candidate.legacy_subject) <> ''
      AND normalize(candidate.legacy_subject, 'NFKC') ~ '^[ -~]+$'
), quarantined AS (
    SELECT * FROM invalid
    UNION
    SELECT * FROM collisions
    UNION
    SELECT * FROM cross_organization
)
INSERT INTO actor_identity_backfill_quarantine (source_table, organization_id, legacy_subject, reason)
SELECT 'organization_memberships', organization_id, legacy_subject, reason
FROM quarantined
ON CONFLICT DO NOTHING;

INSERT INTO actor_identity_backfill_quarantine (source_table, organization_id, legacy_subject, reason)
SELECT DISTINCT 'project_authorization_audit_events', event.organization_id, event.actor_subject, 'orphaned_audit_subject'
FROM project_authorization_audit_events event
LEFT JOIN organization_memberships membership
    ON membership.organization_id = event.organization_id
   AND membership.actor_subject = event.actor_subject
WHERE membership.actor_subject IS NULL
ON CONFLICT DO NOTHING;

DO $$
BEGIN
    IF EXISTS (
        WITH candidates AS (
            SELECT DISTINCT actor_subject AS legacy_subject
            FROM organization_memberships
        ), valid AS (
            SELECT basic_auth_canonical_subject(legacy_subject) AS canonical_subject
            FROM candidates
            WHERE btrim(legacy_subject) <> ''
              AND normalize(legacy_subject, 'NFKC') ~ '^[ -~]+$'
        )
        SELECT durable_actor_id('basic:v1', canonical_subject)
        FROM valid
        GROUP BY durable_actor_id('basic:v1', canonical_subject)
        HAVING count(DISTINCT canonical_subject) > 1
    ) THEN
        RAISE EXCEPTION 'Basic Auth deterministic actor ID collision';
    END IF;
END
$$;

WITH candidates AS (
    SELECT organization_id, actor_subject AS legacy_subject
    FROM organization_memberships
), valid AS (
    SELECT organization_id, legacy_subject, basic_auth_canonical_subject(legacy_subject) AS canonical_subject
    FROM candidates
    WHERE btrim(legacy_subject) <> ''
      AND normalize(legacy_subject, 'NFKC') ~ '^[ -~]+$'
), unique_subjects AS (
    SELECT canonical_subject
    FROM valid
    GROUP BY canonical_subject
    HAVING count(DISTINCT legacy_subject) = 1
       AND count(DISTINCT organization_id) = 1
)
INSERT INTO actors (id)
SELECT durable_actor_id('basic:v1', valid.canonical_subject)
FROM valid
JOIN unique_subjects USING (canonical_subject)
ON CONFLICT DO NOTHING;

WITH candidates AS (
    SELECT organization_id, actor_subject AS legacy_subject
    FROM organization_memberships
), valid AS (
    SELECT organization_id, legacy_subject, basic_auth_canonical_subject(legacy_subject) AS canonical_subject
    FROM candidates
    WHERE btrim(legacy_subject) <> ''
      AND normalize(legacy_subject, 'NFKC') ~ '^[ -~]+$'
), unique_subjects AS (
    SELECT canonical_subject
    FROM valid
    GROUP BY canonical_subject
    HAVING count(DISTINCT legacy_subject) = 1
       AND count(DISTINCT organization_id) = 1
)
INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
SELECT durable_actor_id('basic:v1', valid.canonical_subject), valid.organization_id, 'basic:v1', valid.canonical_subject
FROM valid
JOIN unique_subjects USING (canonical_subject)
ON CONFLICT DO NOTHING;
