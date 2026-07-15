INSERT INTO projects (id, name, slug) VALUES
    ('33333333-3333-3333-3333-333333333333', 'Failure Project', 'failure-project');

INSERT INTO prompts (id, project_id, name, description) VALUES
    ('eeeeeeee-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'Failure Prompt', NULL),
    ('ffffffff-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'Role Failure Prompt', NULL);

INSERT INTO prompt_versions (id, prompt_id, version, content, messages, settings, content_hash, created_by) VALUES
    (
        'eeeeeeee-0000-0000-0000-000000000101',
        'eeeeeeee-0000-0000-0000-000000000001',
        1,
        'legacy source',
        '[{"role":"system","content":"one"},{"role":"user","content":"two"}]',
        '{}'::jsonb,
        prompt_version_content_hash('[{"role":"system","content":"one"},{"role":"user","content":"two"}]'::jsonb, NULL, '{}'::jsonb),
        'legacy-migration'
    ),
    (
        'ffffffff-0000-0000-0000-000000000101',
        'ffffffff-0000-0000-0000-000000000001',
        1,
        'system source',
        '[{"role":"system","content":"system source"}]',
        '{}'::jsonb,
        prompt_version_content_hash('[{"role":"system","content":"system source"}]'::jsonb, NULL, '{}'::jsonb),
        'legacy-migration'
    ),
    (
        'ffffffff-0000-0000-0000-000000000102',
        'ffffffff-0000-0000-0000-000000000001',
        2,
        'user source',
        '[{"role":"user","content":"user source"}]',
        '{}'::jsonb,
        prompt_version_content_hash('[{"role":"user","content":"user source"}]'::jsonb, NULL, '{}'::jsonb),
        'legacy-migration'
    );
