DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'experiment_tasks' AND column_name = 'cost_reservation_usd'
    ) THEN
        RAISE EXCEPTION '0085 did not add persisted task cost reservations';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'experiment_tasks_cost_reservation_check'
    ) THEN
        RAISE EXCEPTION '0085 did not constrain task cost reservations';
    END IF;
END $$;
