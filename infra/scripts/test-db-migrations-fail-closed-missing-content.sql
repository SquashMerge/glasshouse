INSERT INTO projects (id, name, slug) VALUES
    ('55555555-5555-5555-5555-555555555555', 'Missing Content Project', 'missing-content-project');

INSERT INTO prompts (id, project_id, name, description) VALUES
    ('55555555-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555555', 'Missing Content Prompt', NULL);

INSERT INTO prompt_versions (id, prompt_id, version, content, messages, settings, content_hash, created_by) VALUES
    (
        '55555555-0000-0000-0000-000000000101',
        '55555555-0000-0000-0000-000000000001',
        1,
        'missing content source',
        '[{"role":"user"}]',
        '{}'::jsonb,
        prompt_version_content_hash('[{"role":"user"}]'::jsonb, NULL, '{}'::jsonb),
        'legacy-migration'
    );
