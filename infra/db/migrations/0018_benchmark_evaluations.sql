-- Longitudinal benchmark suites use a project-scoped golden dataset as their reference.
CREATE TABLE IF NOT EXISTS benchmark_suites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name),
    UNIQUE (id, project_id),
    CONSTRAINT benchmark_suites_dataset_project_fk
        FOREIGN KEY (dataset_id, project_id)
        REFERENCES datasets (id, project_id)
        ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS experiments_id_project_id_key
    ON experiments(id, project_id);

CREATE TABLE IF NOT EXISTS benchmark_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    suite_id UUID NOT NULL,
    experiment_id UUID NOT NULL UNIQUE REFERENCES experiments(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    model TEXT,
    prompt_version TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT benchmark_runs_suite_project_fk
        FOREIGN KEY (suite_id, project_id)
        REFERENCES benchmark_suites (id, project_id)
        ON DELETE CASCADE,
    CONSTRAINT benchmark_runs_experiment_project_fk
        FOREIGN KEY (experiment_id, project_id)
        REFERENCES experiments (id, project_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_suite_created
    ON benchmark_runs(suite_id, created_at DESC);
