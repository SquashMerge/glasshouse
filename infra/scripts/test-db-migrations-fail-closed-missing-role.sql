INSERT INTO projects (id, name, slug) VALUES
    ('44444444-4444-4444-4444-444444444444', 'Missing Role Project', 'missing-role-project');

INSERT INTO prompts (id, project_id, name, description, slug) VALUES
    ('44444444-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'Missing Role Prompt', NULL, 'missing-role-prompt');

INSERT INTO prompt_versions (id, prompt_id, version, content, messages, settings, content_hash, created_by) VALUES
    (
        '44444444-0000-0000-0000-000000000101',
        '44444444-0000-0000-0000-000000000001',
        1,
        'missing role source',
        '[{"content":"missing role source"}]',
        '{}'::jsonb,
        prompt_version_content_hash('[{"content":"missing role source"}]'::jsonb, NULL, '{}'::jsonb),
        'legacy-migration'
    );
