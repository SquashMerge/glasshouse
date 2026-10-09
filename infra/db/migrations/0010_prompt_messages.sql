-- Glasshouse Postgres migrations: 0010_prompt_messages
-- A prompt version holds its system and user messages together.

DROP TRIGGER IF EXISTS prompts_role_immutable ON prompts;
DROP TRIGGER IF EXISTS prompt_versions_role_matches_prompt ON prompt_versions;
DROP FUNCTION IF EXISTS prevent_prompt_role_update();
DROP FUNCTION IF EXISTS prompt_version_role_matches_prompt();

ALTER TABLE prompts DROP COLUMN IF EXISTS role;

CREATE OR REPLACE FUNCTION prompt_version_messages_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT CASE
        WHEN jsonb_typeof(value) IS DISTINCT FROM 'array' THEN false
        ELSE COALESCE(
            jsonb_array_length(value) BETWEEN 1 AND 2
            AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(value) AS element(message)
                WHERE jsonb_typeof(message) IS DISTINCT FROM 'object'
                    OR jsonb_typeof(message->'role') IS DISTINCT FROM 'string'
                    OR message->>'role' NOT IN ('system', 'user')
                    OR jsonb_typeof(message->'content') IS DISTINCT FROM 'string'
            )
            AND NOT EXISTS (
                SELECT message->>'role'
                FROM jsonb_array_elements(value) AS element(message)
                GROUP BY message->>'role'
                HAVING count(*) > 1
            ),
            false
        )
    END
$$;
