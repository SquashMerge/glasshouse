DO $$
DECLARE
    restore_error TEXT;
BEGIN
    BEGIN
        UPDATE projects
        SET status = 'active'
        WHERE id = '74000000-0000-4000-8000-000000000002';
        RAISE EXCEPTION '0074 precondition unexpectedly restored a managerless project';
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS restore_error = MESSAGE_TEXT;
        IF restore_error <> 'cannot restore a project without a manager' THEN
            RAISE;
        END IF;
    END;

    IF NOT EXISTS (
        SELECT 1 FROM projects
        WHERE id = '74000000-0000-4000-8000-000000000002'
          AND status = 'archived'
    ) THEN
        RAISE EXCEPTION '0074 precondition did not preserve the archived project';
    END IF;
END
$$;
