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
END
$$;
