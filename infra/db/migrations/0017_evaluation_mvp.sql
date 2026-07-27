-- Evaluation MVP can invoke the configured LLM directly before agent registry is shipped.
ALTER TABLE experiments ALTER COLUMN agent_id DROP NOT NULL;
