SELECT CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'evaluations' AND column_name = 'tombstoned_at'
) THEN 1 ELSE 1 / 0 END;
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'evaluations_hard_delete_guard'
) THEN 1 ELSE 1 / 0 END;
