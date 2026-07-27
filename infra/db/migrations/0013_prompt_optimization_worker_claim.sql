-- A durable claim prevents multiple API instances from executing one active job.
ALTER TABLE prompt_optimization_jobs
    ADD COLUMN IF NOT EXISTS worker_claim_id UUID,
    ADD COLUMN IF NOT EXISTS worker_claimed_at TIMESTAMPTZ;
