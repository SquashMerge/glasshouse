ALTER TABLE traces
    ADD CONSTRAINT IF NOT EXISTS traces_retained_payload_bounds
    CHECK length(input_text) <= 8192 AND length(output_text) <= 8192 AND length(metadata) <= 16384;

ALTER TABLE observations
    ADD CONSTRAINT IF NOT EXISTS observations_retained_payload_bounds
    CHECK length(input_text) <= 8192 AND length(output_text) <= 8192 AND length(metadata) <= 16384;
