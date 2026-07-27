-- Claims expire so a crashed or replaced API replica cannot strand an active job.
ALTER TABLE prompt_optimization_jobs
    ADD COLUMN IF NOT EXISTS worker_lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS prompt_optimization_jobs_reclaimable_lease_idx
    ON prompt_optimization_jobs(worker_lease_expires_at)
    WHERE status IN ('queued', 'preparing', 'optimizing', 'evaluating');
