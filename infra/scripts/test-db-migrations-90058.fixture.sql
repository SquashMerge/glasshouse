INSERT INTO internal_log_entries (
    id,
    organization_id,
    recorded_at,
    severity,
    source,
    message,
    context
)
SELECT
    '90058000-0000-4000-8000-000000000001',
    id,
    '2026-11-01T00:01:00.123456Z'::timestamptz,
    'info',
    'api',
    'API request outcome',
    '{"route":"projects","method":"GET","status":200,"duration_ms":1}'::jsonb
FROM organizations
WHERE slug = 'default';
