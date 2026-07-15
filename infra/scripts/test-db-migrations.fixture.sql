INSERT INTO projects (id, name, slug) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Project One', 'project-one'),
    ('22222222-2222-2222-2222-222222222222', 'Project Two', 'project-two');

INSERT INTO prompts (id, project_id, name, description) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'First Prompt!', 'first'),
    ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Greeting', NULL),
    ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'greeting', NULL),
    ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', ' !!! ', NULL);

INSERT INTO prompt_versions (id, prompt_id, version, content, model, metadata, created_at) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001', 1, 'Hello {{name}}', 'legacy-model', '{"temperature": 0.1}', '2024-01-01T00:00:00Z'),
    ('aaaaaaaa-0000-0000-0000-000000000102', 'aaaaaaaa-0000-0000-0000-000000000001', 0, 'Legacy zero', NULL, '{}', '2024-01-02T00:00:00Z'),
    ('bbbbbbbb-0000-0000-0000-000000000101', 'bbbbbbbb-0000-0000-0000-000000000001', 1, 'Greeting', NULL, '{}', '2024-01-01T00:00:00Z'),
    ('cccccccc-0000-0000-0000-000000000101', 'cccccccc-0000-0000-0000-000000000001', -2, 'Malformed {{template', NULL, '["not-an-object"]', '2024-01-01T00:00:00Z'),
    ('dddddddd-0000-0000-0000-000000000101', 'dddddddd-0000-0000-0000-000000000001', 0, 'Legacy empty name', NULL, '{}', '2024-01-01T00:00:00Z');

INSERT INTO prompt_labels (project_id, prompt_id, label, version_id) VALUES
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'production', 'aaaaaaaa-0000-0000-0000-000000000101'),
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'invalid!', 'aaaaaaaa-0000-0000-0000-000000000101'),
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'latest', 'aaaaaaaa-0000-0000-0000-000000000101'),
    ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001', 'tenant', 'aaaaaaaa-0000-0000-0000-000000000101'),
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'version-link', 'bbbbbbbb-0000-0000-0000-000000000101');
