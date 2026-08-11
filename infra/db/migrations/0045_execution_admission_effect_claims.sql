-- A claim commits before its corresponding provider or external writer call.
-- It is a PostgreSQL logical admission boundary, not a distributed transaction
-- with the provider or ClickHouse.
CREATE TABLE IF NOT EXISTS execution_admission_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admission_id UUID NOT NULL REFERENCES execution_admissions(id) ON DELETE CASCADE,
    effect TEXT NOT NULL CHECK (effect IN (
        'provider_dispatch',
        'trace_write',
        'metric_write',
        'result_write',
        'event_write'
    )),
    authorization_epoch BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'completed')),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    cancelled_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CONSTRAINT execution_admission_claims_terminal_timestamp_check CHECK (
        (status = 'active' AND cancelled_at IS NULL AND completed_at IS NULL)
        OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
        OR (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS execution_admission_claims_active_admission_idx
    ON execution_admission_claims (admission_id, authorization_epoch)
    WHERE status = 'active';

CREATE OR REPLACE FUNCTION settle_execution_admission_claims()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    IF NEW.status = 'cancelled' THEN
        UPDATE execution_admission_claims
        SET status = 'cancelled', cancelled_at = now()
        WHERE admission_id = NEW.id
          AND status = 'active';
    ELSIF NEW.status = 'completed' THEN
        UPDATE execution_admission_claims
        SET status = 'completed', completed_at = now()
        WHERE admission_id = NEW.id
          AND status = 'active';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS execution_admission_claim_settlement ON execution_admissions;
CREATE TRIGGER execution_admission_claim_settlement
AFTER UPDATE OF status ON execution_admissions
FOR EACH ROW EXECUTE FUNCTION settle_execution_admission_claims();
