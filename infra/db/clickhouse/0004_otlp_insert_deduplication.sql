-- Retain a bounded history of insert block IDs so retry tokens deduplicate OTLP
-- batches after a partial write. This is not a permanent uniqueness constraint.
ALTER TABLE traces
    MODIFY SETTING non_replicated_deduplication_window = 100000;

ALTER TABLE observations
    MODIFY SETTING non_replicated_deduplication_window = 100000;
