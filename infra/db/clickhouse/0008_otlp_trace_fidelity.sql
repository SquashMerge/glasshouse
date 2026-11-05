-- Exact source times are unknown on legacy/internal rows. Never derive fake nanos.
ALTER TABLE traces
    ADD COLUMN IF NOT EXISTS start_time_unix_nano Nullable(UInt64) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS end_time_unix_nano Nullable(UInt64) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS duration_nano Nullable(UInt64) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS precise_duration_ms Nullable(Float64) DEFAULT NULL;

ALTER TABLE observations
    ADD COLUMN IF NOT EXISTS start_time_unix_nano Nullable(UInt64) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS end_time_unix_nano Nullable(UInt64) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS duration_nano Nullable(UInt64) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS precise_duration_ms Nullable(Float64) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS otlp String DEFAULT '',
    ADD CONSTRAINT IF NOT EXISTS observations_otlp_payload_bounds CHECK length(otlp) <= 32768;
