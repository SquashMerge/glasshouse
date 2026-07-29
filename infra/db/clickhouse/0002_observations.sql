-- Astraea ClickHouse schema: observations
-- Companion to traces. One trace has many observations.

CREATE TABLE IF NOT EXISTS observations (
    observation_id          String,
    trace_id                String,
    organization_id         String,
    project_id              String,
    parent_observation_id   Nullable(String),
    type                    LowCardinality(String),
    name                    String,
    start_time              DateTime64(3),
    end_time                Nullable(DateTime64(3)),
    duration_ms             Nullable(UInt32),
    status                  LowCardinality(String),
    model                   Nullable(String),
    input_text              String,
    output_text             String,
    metadata                String
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(start_time)
ORDER BY (organization_id, trace_id, start_time, observation_id);

ALTER TABLE observations
    ADD INDEX IF NOT EXISTS idx_obs_trace_id trace_id TYPE bloom_filter(0.01) GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_obs_type type TYPE set(8) GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_obs_status status TYPE set(4) GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_obs_input_text input_text TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_obs_output_text output_text TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4;