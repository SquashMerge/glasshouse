-- One active optimization may exist for an immutable prompt start key.
CREATE UNIQUE INDEX IF NOT EXISTS prompt_optimization_jobs_active_start_key_idx
    ON prompt_optimization_jobs(project_id, prompt_id, source_version, target_role)
    WHERE status IN ('queued', 'preparing', 'optimizing', 'evaluating');
