DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM actor_identity_backfill_quarantine
        WHERE source_table = 'organization_memberships'
          AND legacy_subject = 'Legacy User'
          AND reason = 'canonical_subject_collision'
    ) OR NOT EXISTS (
        SELECT 1 FROM actor_identity_backfill_quarantine
        WHERE source_table = 'organization_memberships'
          AND legacy_subject = ' legacy user '
          AND reason = 'canonical_subject_collision'
    ) OR NOT EXISTS (
        SELECT 1 FROM actor_identity_backfill_quarantine
        WHERE source_table = 'organization_memberships'
          AND legacy_subject = '   '
          AND reason = 'malformed_subject'
    ) THEN
        RAISE EXCEPTION 'invalid legacy Basic Auth subjects were not quarantined';
    END IF;

    IF EXISTS (
        SELECT 1 FROM actor_identities
        WHERE provider_namespace = 'basic:v1'
          AND canonical_subject = 'legacy user'
    ) THEN
        RAISE EXCEPTION 'canonical collision was silently merged into an actor';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM actor_identity_backfill_quarantine
        WHERE source_table = 'organization_memberships'
          AND legacy_subject = 'Shared User'
          AND reason = 'cross_organization_subject'
    ) OR EXISTS (
        SELECT 1 FROM actor_identities
        WHERE provider_namespace = 'basic:v1'
          AND canonical_subject = 'shared user'
    ) THEN
        RAISE EXCEPTION 'cross-organization Basic Auth subject was not rejected';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM actor_identity_backfill_quarantine quarantine
        JOIN actor_identities identity
          ON identity.provider_namespace = 'basic:v1'
         AND identity.canonical_subject = CASE
            WHEN btrim(quarantine.legacy_subject) <> ''
             AND normalize(quarantine.legacy_subject, 'NFKC') ~ '^[ -~]+$'
            THEN lower(btrim(normalize(quarantine.legacy_subject, 'NFKC')))
            ELSE NULL
         END
        WHERE quarantine.source_table = 'organization_memberships'
          AND quarantine.reason IN ('canonical_subject_collision', 'cross_organization_subject')
    ) THEN
        RAISE EXCEPTION 'quarantined Basic Auth collision produced an actor identity';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM actor_identities
        WHERE organization_id = '99999999-9999-4999-8999-999999999999'
          AND provider_namespace = 'basic:v1'
          AND canonical_subject = 'preserved user'
          AND actor_id = durable_actor_id('basic:v1', 'preserved user')
    ) OR NOT basic_auth_identity_matches(
        '99999999-9999-4999-8999-999999999999',
        'PRESERVED USER',
        durable_actor_id('basic:v1', 'preserved user')
    ) THEN
        RAISE EXCEPTION 'normalized legacy Basic Auth membership was not preserved';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'actor_identities'
          AND column_name = 'organization_id'
          AND is_nullable = 'YES'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'actor_identities'::regclass
          AND contype = 'f'
          AND pg_get_constraintdef(oid) LIKE '%organization_id%organizations%'
    ) THEN
        RAISE EXCEPTION 'actor identities are not organization tenant-backed';
    END IF;
END
$$;
