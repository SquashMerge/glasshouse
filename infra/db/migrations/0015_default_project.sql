-- Glasshouse Postgres migrations: 0015_default_project
-- Fresh installations need one tenant before the dashboard can be used.

INSERT INTO projects (name, slug)
VALUES ('Default Project', 'default')
ON CONFLICT (slug) DO NOTHING;
