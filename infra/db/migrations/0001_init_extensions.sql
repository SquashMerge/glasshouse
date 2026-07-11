-- Astraea Postgres migrations: 0001_init_extensions
-- Enables pgcrypto for gen_random_uuid(). If managed Postgres disallows
-- CREATE EXTENSION, fall back to app-side UUID generation (see apps/api/src/db/postgres.ts).

CREATE EXTENSION IF NOT EXISTS pgcrypto;