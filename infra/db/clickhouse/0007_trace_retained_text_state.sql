ALTER TABLE traces
    ADD COLUMN IF NOT EXISTS input_retained_truncated Bool DEFAULT false;

ALTER TABLE traces
    ADD COLUMN IF NOT EXISTS output_retained_truncated Bool DEFAULT false;

ALTER TABLE observations
    ADD COLUMN IF NOT EXISTS input_retained_truncated Bool DEFAULT false;

ALTER TABLE observations
    ADD COLUMN IF NOT EXISTS output_retained_truncated Bool DEFAULT false;
