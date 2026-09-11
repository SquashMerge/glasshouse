-- Reserve the remaining immutable run budget before provider dispatch. The
-- experiment row lock serializes reservations across API processes.
ALTER TABLE experiment_tasks
    ADD COLUMN IF NOT EXISTS cost_reservation_usd NUMERIC(12, 6);

ALTER TABLE experiment_tasks
    DROP CONSTRAINT IF EXISTS experiment_tasks_cost_reservation_check;
ALTER TABLE experiment_tasks
    ADD CONSTRAINT experiment_tasks_cost_reservation_check
    CHECK (cost_reservation_usd IS NULL OR cost_reservation_usd > 0);
