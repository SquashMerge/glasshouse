ALTER TABLE governance_retention_runs
    ADD COLUMN IF NOT EXISTS owner_token UUID,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

-- Existing in-flight runs predate leases. Give them a bounded grace period rather
-- than allowing a newly started process to immediately terminalize live work.
UPDATE governance_retention_runs
SET owner_token = COALESCE(owner_token, gen_random_uuid()),
    heartbeat_at = COALESCE(heartbeat_at, now()),
    lease_expires_at = COALESCE(lease_expires_at, now() + interval '5 minutes')
WHERE status = 'running';

ALTER TABLE governance_retention_runs
    ADD CONSTRAINT governance_retention_runs_running_lease
    CHECK (
        (status = 'running' AND owner_token IS NOT NULL AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL)
        OR status <> 'running'
    );

CREATE INDEX IF NOT EXISTS governance_retention_runs_expired_lease
    ON governance_retention_runs(lease_expires_at)
    WHERE status = 'running';
