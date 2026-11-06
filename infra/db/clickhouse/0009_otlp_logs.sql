CREATE TABLE IF NOT EXISTS logs
(
    log_id String,
    organization_id String,
    project_id String,
    time_unix_nano UInt64 DEFAULT 0,
    observed_time_unix_nano UInt64 DEFAULT 0,
    ingested_time_unix_nano UInt64,
    effective_time_unix_nano UInt64 MATERIALIZED if(time_unix_nano != 0, time_unix_nano, if(observed_time_unix_nano != 0, observed_time_unix_nano, ingested_time_unix_nano)),
    severity_number UInt8 DEFAULT 0,
    severity_text String DEFAULT '',
    trace_id Nullable(String),
    span_id Nullable(String),
    flags UInt32 DEFAULT 0,
    dropped_attributes_count UInt32 DEFAULT 0,
    event_name String DEFAULT '',
    body String DEFAULT '{}',
    attributes String DEFAULT '[]',
    resource String DEFAULT '{"attributes":[],"droppedAttributesCount":0}',
    scope String DEFAULT '{"name":"","version":"","attributes":[],"droppedAttributesCount":0}',
    resource_schema_url String DEFAULT '',
    scope_schema_url String DEFAULT '',
    CONSTRAINT logs_tenant_scope CHECK notEmpty(organization_id) AND notEmpty(project_id)
)
ENGINE = MergeTree
ORDER BY (organization_id, project_id, effective_time_unix_nano, log_id)
SETTINGS non_replicated_deduplication_window = 100000;
