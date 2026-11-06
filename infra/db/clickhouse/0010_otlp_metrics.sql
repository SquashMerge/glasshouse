CREATE TABLE IF NOT EXISTS metrics
(
    organization_id String,
    project_id String,
    point_id String,
    series_id String,
    name String,
    description String,
    unit String,
    metric_type Enum8('gauge' = 1, 'sum' = 2, 'histogram' = 3, 'exponential_histogram' = 4, 'summary' = 5),
    aggregation_temporality UInt8,
    is_monotonic Bool,
    time_unix_nano UInt64,
    resource_attributes String,
    resource_dropped_attributes_count UInt32,
    resource_schema_url String,
    scope_name String,
    scope_version String,
    scope_attributes String,
    scope_dropped_attributes_count UInt32,
    scope_schema_url String,
    metric_metadata String,
    data_point String,
    CONSTRAINT metrics_tenant_scope_required CHECK notEmpty(organization_id) AND notEmpty(project_id),
    CONSTRAINT metrics_retained_payload_bounds CHECK
        length(name) + length(description) + length(unit) +
        length(resource_attributes) + length(resource_schema_url) +
        length(scope_name) + length(scope_version) + length(scope_attributes) +
        length(scope_schema_url) + length(metric_metadata) + length(data_point) <= 65536
)
ENGINE = MergeTree
PARTITION BY intDiv(time_unix_nano, 2592000000000000)
ORDER BY (organization_id, project_id, time_unix_nano, point_id)
SETTINGS non_replicated_deduplication_window = 100000;
