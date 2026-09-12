-- A populated legacy database can contain zero-report Evaluation Runs. The
-- upgrade must preserve that absence rather than inventing client evidence.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM agent_introspection_reports) THEN
        RAISE EXCEPTION '0091 fixture requires no legacy introspection reports';
    END IF;
END $$;
