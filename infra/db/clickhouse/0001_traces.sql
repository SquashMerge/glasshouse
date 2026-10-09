-- Glasshouse ClickHouse schema: traces
-- Partition by month; sort key (organization_id, project_id, start_time, trace_id);
-- skip indexes + bloom filters + tokenbf_v1 full-text per design doc §10.

CREATE TABLE IF NOT EXISTS traces (
    trace_id        String,
    organization_id String,
    project_id      String,
    name            String,
    start_time      DateTime64(3),
    end_time        Nullable(DateTime64(3)),
    duration_ms     Nullable(UInt32),
    status          LowCardinality(String),
    user_id         String,
    session_id      String,
    agent_id        String,
    agent_version   String,
    env             LowCardinality(String),
    tags            Array(LowCardinality(String)),
    input_text      String,
    output_text     String,
    scores_summary  String,
    metadata        String
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(start_time)
ORDER BY (organization_id, project_id, start_time, trace_id);

ALTER TABLE traces
    ADD INDEX IF NOT EXISTS idx_status status TYPE set(4) GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_env env TYPE set(4) GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_agent agent_id TYPE bloom_filter(0.01) GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_user user_id TYPE bloom_filter(0.01) GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_session session_id TYPE bloom_filter(0.01) GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_tags tags TYPE bloom_filter(0.01) GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_input_text input_text TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4,
    ADD INDEX IF NOT EXISTS idx_output_text output_text TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4;