-- Persist insert coordinates across merges and mutations, including for old parts.
-- Unlike log_id, these distinguish physical retries without collapsing payloads.
ALTER TABLE logs MODIFY SETTING enable_block_number_column = 1, enable_block_offset_column = 1;
