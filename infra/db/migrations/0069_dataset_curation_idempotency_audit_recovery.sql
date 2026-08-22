-- Recover 0067 curation retries whose draft was consumed before 0068 persisted
-- its target. The immutable audit entry and idempotency record share the same
-- transaction timestamp, actor, operation, and draft revision; ambiguous history stays
-- unresolved rather than assigning a target by inference.
WITH candidates AS (
    SELECT idempotency.id, MIN(event.dataset_id::text)::uuid AS dataset_id
    FROM dataset_curation_idempotency AS idempotency
    JOIN dataset_lifecycle_audit_events AS event
      ON event.project_id = idempotency.project_id
     AND event.created_at = idempotency.created_at
     AND event.actor_id = idempotency.actor_id
     AND event.draft_revision::text = idempotency.response ->> 'revision'
     AND event.event_type = CASE
         WHEN idempotency.operation = 'import' THEN 'draft_items_imported'
         ELSE 'draft_item_captured'
     END
    JOIN datasets AS dataset
      ON dataset.project_id = event.project_id
     AND dataset.id = event.dataset_id
    WHERE idempotency.dataset_id IS NULL
      AND idempotency.response ->> 'revision' ~ '^[1-9][0-9]*$'
    GROUP BY idempotency.id
    HAVING COUNT(DISTINCT event.dataset_id) = 1
)
UPDATE dataset_curation_idempotency AS idempotency
SET dataset_id = candidates.dataset_id
FROM candidates
WHERE idempotency.id = candidates.id;
