-- Evaluation MVP can invoke the configured LLM directly before agent registry is shipped.
ALTER TABLE experiments ALTER COLUMN agent_id DROP NOT NULL;

-- Enforce that an experiment's dataset belongs to the same project.
ALTER TABLE datasets
    ADD CONSTRAINT datasets_id_project_id_key UNIQUE (id, project_id);

ALTER TABLE experiments
    ADD CONSTRAINT experiments_dataset_project_fk
    FOREIGN KEY (dataset_id, project_id)
    REFERENCES datasets (id, project_id)
    ON DELETE RESTRICT;
