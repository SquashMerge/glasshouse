BEGIN;

INSERT INTO datasets (id, project_id, name)
VALUES (
    '66666666-6666-4666-8666-666666666620',
    '66666666-6666-4666-8666-666666666665',
    'Requester authorization dataset'
);
INSERT INTO dataset_items (id, dataset_id, input, expected_output)
VALUES (
    '66666666-6666-4666-8666-666666666621',
    '66666666-6666-4666-8666-666666666620',
    '{"question":"one"}',
    '{"value":"one"}'
);
INSERT INTO experiments (id, project_id, agent_id, dataset_id, name, config, status)
VALUES (
    '66666666-6666-4666-8666-666666666622',
    '66666666-6666-4666-8666-666666666665',
    NULL,
    '66666666-6666-4666-8666-666666666620',
    'Historical unbound experiment',
    '{}',
    'pending'
);

COMMIT;
