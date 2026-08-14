DO $$
BEGIN
	IF (SELECT slug FROM datasets WHERE id = 'a4000000-0000-4000-8000-000000000001') <> 'legacy-evaluation-dataset' THEN
		RAISE EXCEPTION 'dataset slug backfill was not deterministic';
	END IF;
	INSERT INTO datasets (id, project_id, name)
	VALUES (
		'a4000000-0000-4000-8000-000000000002',
		'11111111-1111-1111-1111-111111111111',
		'Direct write compatibility dataset'
	);
	IF (SELECT slug FROM datasets WHERE id = 'a4000000-0000-4000-8000-000000000002') <> 'dataset-a4000000000040008000000000000002' THEN
		RAISE EXCEPTION 'direct dataset writes did not receive a stable slug';
	END IF;
	IF (SELECT latest_published_version FROM datasets WHERE id = 'a4000000-0000-4000-8000-000000000001') <> 1 THEN
		RAISE EXCEPTION 'legacy dataset was not snapshotted as version one';
	END IF;
	IF (SELECT count(*) FROM dataset_version_items WHERE dataset_version_id = (SELECT id FROM dataset_versions WHERE dataset_id = 'a4000000-0000-4000-8000-000000000001' AND version = 1)) <> 2 THEN
		RAISE EXCEPTION 'legacy dataset item snapshots were not retained';
	END IF;
	IF (SELECT input FROM dataset_items WHERE id = 'a5000000-0000-4000-8000-000000000003') <> '{"legacy_input":"legacy scalar"}'::jsonb
		OR NOT EXISTS (SELECT 1 FROM dataset_item_input_quarantine WHERE dataset_item_id = 'a5000000-0000-4000-8000-000000000003') THEN
		RAISE EXCEPTION 'legacy scalar dataset input was not normalized and quarantined before snapshots';
	END IF;
	IF (SELECT input FROM dataset_items WHERE id = 'a5000000-0000-4000-8000-000000000004') <> '{"legacy_input":["legacy","array"]}'::jsonb
		OR NOT EXISTS (SELECT 1 FROM dataset_item_input_quarantine WHERE dataset_item_id = 'a5000000-0000-4000-8000-000000000004') THEN
		RAISE EXCEPTION 'legacy array dataset input was not normalized and quarantined before snapshots';
	END IF;
	IF (SELECT count(*) FROM dataset_version_items WHERE dataset_version_id = (SELECT id FROM dataset_versions WHERE dataset_id = 'a4000000-0000-4000-8000-000000000003' AND version = 1)) <> 2 THEN
		RAISE EXCEPTION 'normalized scalar and array items were not retained in the immutable snapshot';
	END IF;
	BEGIN
		INSERT INTO experiments (id, project_id, agent_id, dataset_id, status)
		VALUES ('a6000000-0000-4000-8000-000000000002', '22222222-2222-2222-2222-222222222222', 'a3000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'completed');
		RAISE EXCEPTION 'cross-project experiment dataset reference was accepted';
	EXCEPTION WHEN foreign_key_violation THEN NULL;
	END;
	INSERT INTO agents (id, project_id, name) VALUES ('a3000000-0000-4000-8000-000000000002', '22222222-2222-2222-2222-222222222222', 'Second project agent');
	INSERT INTO datasets (id, project_id, name) VALUES ('a4000000-0000-4000-8000-000000000004', '22222222-2222-2222-2222-222222222222', 'Second project dataset');
	INSERT INTO actors (id) VALUES ('a6000000-0000-4000-8000-000000000004');
	INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
	SELECT 'a6000000-0000-4000-8000-000000000004', organization_id, 'basic:v1', 'migration-cross-project-probe'
	FROM projects
	WHERE id = '22222222-2222-2222-2222-222222222222';
	INSERT INTO experiments (id, project_id, agent_id, dataset_id, requested_by_actor_id) VALUES ('a6000000-0000-4000-8000-000000000003', '22222222-2222-2222-2222-222222222222', 'a3000000-0000-4000-8000-000000000002', 'a4000000-0000-4000-8000-000000000004', 'a6000000-0000-4000-8000-000000000004');
	BEGIN
		INSERT INTO experiment_tasks (project_id, experiment_id, dataset_version_item_id)
		SELECT '22222222-2222-2222-2222-222222222222', 'a6000000-0000-4000-8000-000000000003', id FROM dataset_version_items WHERE project_id = '11111111-1111-1111-1111-111111111111' LIMIT 1;
		RAISE EXCEPTION 'cross-project snapshot task reference was accepted';
	EXCEPTION WHEN foreign_key_violation THEN NULL;
	END;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'feedback_reviews'::regclass AND conname = 'feedback_reviews_dataset_draft_item_project_fk' AND pg_get_constraintdef(oid) LIKE '%FOREIGN KEY (dataset_draft_item_id, project_id)%' AND pg_get_constraintdef(oid) LIKE '%ON DELETE RESTRICT%')
		OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'feedback_reviews'::regclass AND conname = 'feedback_reviews_dataset_version_item_project_fk' AND pg_get_constraintdef(oid) LIKE '%FOREIGN KEY (dataset_item_id, project_id)%') THEN
		RAISE EXCEPTION 'feedback links must retain project-scoped draft and immutable snapshot ownership';
	END IF;
	INSERT INTO dataset_drafts (id, project_id, dataset_id, created_by)
	VALUES ('a4000000-0000-4000-8000-000000000005', '11111111-1111-1111-1111-111111111111', 'a4000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000006');
	INSERT INTO dataset_draft_items (id, project_id, draft_id, item_key, position, input)
	VALUES ('a4000000-0000-4000-8000-000000000007', '11111111-1111-1111-1111-111111111111', 'a4000000-0000-4000-8000-000000000005', 'cross-project-feedback', 0, '{}'::jsonb);
	INSERT INTO scores (id, project_id, name, value)
	VALUES ('a4000000-0000-4000-8000-000000000008', '22222222-2222-2222-2222-222222222222', 'human.feedback', 1);
	BEGIN
		INSERT INTO feedback_reviews (score_id, project_id, status, dataset_id, dataset_item_id)
		SELECT 'a4000000-0000-4000-8000-000000000008', '22222222-2222-2222-2222-222222222222', 'added_to_dataset', 'a4000000-0000-4000-8000-000000000004', id
		FROM dataset_version_items
		WHERE project_id = '11111111-1111-1111-1111-111111111111'
		LIMIT 1;
		RAISE EXCEPTION 'cross-project feedback snapshot link was accepted';
	EXCEPTION WHEN check_violation OR foreign_key_violation THEN NULL;
	END;
	IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'governance_policy_versions')
		OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'governance_policy_approvals')
		OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'governance_retention_runs') THEN
		RAISE EXCEPTION 'governance persistence is incomplete';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'default_project_id' AND is_nullable = 'NO')
		OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_default_project_organization_fkey')
		OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'project_lifecycle_audit_events') THEN
		RAISE EXCEPTION 'organization default project lifecycle persistence is incomplete';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'governance_retention_previews')
		OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'governance_retention_runs_one_running_per_project' AND indexdef LIKE '%WHERE (status = ''running''::text)%') THEN
		RAISE EXCEPTION 'retention preview authorization or single-running-run constraint is incomplete';
	END IF;
	IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'governance_retention_runs' AND column_name IN ('owner_token', 'lease_expires_at', 'heartbeat_at')) <> 3
		OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'governance_retention_runs_expired_lease') THEN
		RAISE EXCEPTION 'retention lease ownership fields are incomplete';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'governance_retention_runs'::regclass AND conname = 'governance_retention_runs_running_lease') THEN
		RAISE EXCEPTION 'retention running lease invariant is incomplete';
	END IF;
	IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('governance_policies', 'governance_policy_versions', 'governance_policy_approvals', 'governance_audit_events', 'governance_retention_runs') AND column_name IN ('organization_id', 'project_id') AND is_nullable = 'NO') <> 10 THEN
		RAISE EXCEPTION 'governance tenant fields must be not null';
	END IF;
	IF (SELECT count(*) FROM pg_constraint WHERE conname IN ('governance_policies_project_organization_fkey', 'governance_policy_versions_project_organization_fkey', 'governance_policy_approvals_version_tenant_fkey', 'governance_retention_runs_version_tenant_fkey')) <> 4 THEN
		RAISE EXCEPTION 'governance composite ownership constraints are incomplete';
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'governance_audit_events'::regclass
			AND conname = 'governance_audit_events_policy_version_fkey'
			AND pg_get_constraintdef(oid) LIKE '%FOREIGN KEY (policy_version_id, organization_id, project_id)%'
			AND pg_get_constraintdef(oid) LIKE '%ON DELETE SET NULL (policy_version_id)%'
	) OR EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'governance_audit_events'
			AND column_name = 'project_id' AND is_nullable <> 'NO'
	) OR NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'governance_audit_events'
			AND column_name = 'policy_version_id' AND is_nullable = 'YES'
	) OR EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name IN ('project_authorization_audit_events', 'project_lifecycle_audit_events')
			AND column_name = 'project_id' AND is_nullable <> 'NO'
	) OR EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'project_authorization_audit_events'::regclass
			AND conname = 'project_authorization_audit_events_project_organization_fkey'
	) THEN
		RAISE EXCEPTION 'project deletion audit provenance constraints are incomplete';
	END IF;
	IF EXISTS (
		SELECT 1
		FROM (VALUES
			('projects'::regclass, 'projects_audit_uuid_reuse_guard', 'prevent_project_audit_uuid_reuse'::regproc, 23::smallint),
			('project_authorization_audit_events'::regclass, 'project_authorization_audit_events_00_provenance_lock', 'enforce_retained_audit_project_provenance'::regproc, 23::smallint),
			('project_lifecycle_audit_events'::regclass, 'project_lifecycle_audit_events_00_provenance_lock', 'enforce_retained_audit_project_provenance'::regproc, 23::smallint),
			('governance_audit_events'::regclass, 'governance_audit_events_00_provenance_lock', 'enforce_retained_audit_project_provenance'::regproc, 23::smallint),
			('project_lifecycle_audit_events'::regclass, 'project_lifecycle_audit_events_immutable', 'prevent_project_lifecycle_audit_mutation'::regproc, 27::smallint)
		) AS expected(tgrelid, tgname, tgfoid, tgtype)
		WHERE NOT EXISTS (
			SELECT 1 FROM pg_trigger
			WHERE pg_trigger.tgrelid = expected.tgrelid
				AND pg_trigger.tgname = expected.tgname
				AND pg_trigger.tgfoid = expected.tgfoid
				AND pg_trigger.tgtype = expected.tgtype
				AND pg_trigger.tgenabled = 'O'
				AND NOT pg_trigger.tgisinternal
		)
	) THEN
		RAISE EXCEPTION 'retained audit provenance serialization is incomplete';
	END IF;
	IF pg_get_functiondef('fence_authorization_membership_revocation'::regproc) NOT LIKE '%FOR UPDATE%'
		OR pg_get_functiondef('fence_authorization_membership_revocation'::regproc) NOT LIKE '%lock_project_audit_provenance%'
		OR pg_get_functiondef('enforce_retained_audit_project_provenance'::regproc) NOT LIKE '%FOR KEY SHARE%'
		OR pg_get_functiondef('enforce_retained_audit_project_provenance'::regproc) NOT LIKE '%lock_project_audit_provenance%' THEN
		RAISE EXCEPTION 'membership, project, and retained-audit lock ordering is incomplete';
	END IF;
	IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'project_deletion_jobs')
		OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'projects'::regclass AND conname = 'projects_status_check' AND pg_get_constraintdef(oid) LIKE '%deleting%')
		OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_deletion_jobs'::regclass AND conname LIKE '%project_id_key%') THEN
		RAISE EXCEPTION 'durable project deletion saga persistence is incomplete';
	END IF;
	INSERT INTO project_deletion_jobs (organization_id, project_id, requested_by, status)
	VALUES ('00000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'migration-test', 'pending');
	IF NOT EXISTS (SELECT 1 FROM project_deletion_jobs WHERE project_id = '11111111-1111-1111-1111-111111111111' AND status = 'pending') THEN
		RAISE EXCEPTION 'project deletion job fixture was not retained';
	END IF;
	IF pg_get_functiondef('prevent_prompt_tombstone_mutation'::regproc) NOT LIKE '%project_deletion_is_authorized%'
		OR pg_get_functiondef('prevent_prompt_deletion_audit_mutation'::regproc) NOT LIKE '%project_deletion_is_authorized%'
		OR pg_get_functiondef('prevent_human_feedback_score_mutation'::regproc) NOT LIKE '%project_deletion_is_authorized%'
		OR pg_get_functiondef('prevent_prompt_optimization_event_mutation'::regproc) NOT LIKE '%project_deletion_is_authorized%'
		OR pg_get_functiondef('prevent_governance_immutable_mutation'::regproc) NOT LIKE '%project_deletion_is_authorized%' THEN
		RAISE EXCEPTION 'immutable records do not have a project-scoped deletion escape';
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'scores' AND column_name = 'observation_id'
	) OR NOT EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = 'feedback_reviews'
	) OR NOT EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = 'feedback_idempotency'
	) THEN
		RAISE EXCEPTION 'feedback first-pass persistence is incomplete';
	END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM organizations AS organization
		JOIN projects AS project
			ON project.id = organization.default_project_id
			AND project.organization_id = organization.id
		WHERE organization.id = '00000000-0000-4000-8000-000000000001'
			AND organization.slug = 'default'
			AND organization.name = 'Default Organization'
			AND project.slug = 'default'
			AND project.name = 'Default Project'
	) THEN
		RAISE EXCEPTION 'default project was not seeded';
	END IF;

    IF (SELECT slug FROM prompts WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001') <> 'first-prompt' THEN
        RAISE EXCEPTION 'first prompt slug was not normalized';
    END IF;
    IF (SELECT slug FROM prompts WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001') <> 'greeting' THEN
        RAISE EXCEPTION 'first colliding slug was not retained';
    END IF;
    IF (SELECT slug FROM prompts WHERE id = 'cccccccc-0000-0000-0000-000000000001') <> 'greeting-cccccccc0000' THEN
        RAISE EXCEPTION 'colliding slug did not use its deterministic UUID suffix';
    END IF;
    IF (SELECT slug FROM prompts WHERE id = 'dddddddd-0000-0000-0000-000000000001') <> 'prompt' THEN
        RAISE EXCEPTION 'empty slug base did not use prompt fallback';
    END IF;
    IF (SELECT slug FROM prompts WHERE id = 'eeeeeeee-0000-0000-0000-000000000001') <> repeat('a', 63) THEN
        RAISE EXCEPTION 'slug truncation left a boundary separator';
    END IF;
    IF EXISTS (SELECT 1 FROM prompts WHERE slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(slug) > 64) THEN
        RAISE EXCEPTION 'a migrated slug is not canonical';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE id = 'aaaaaaaa-0000-0000-0000-000000000101'
            AND version = 1
            AND legacy_version IS NULL
            AND content = 'Hello {{name}}'
            AND messages = '[{"role":"user","content":"Hello {{name}}"}]'::jsonb
            AND settings = '{"temperature":0.1}'::jsonb
            AND created_by = 'legacy-migration'
            AND change_message = 'Initial version'
            AND content_hash = '314fa73f1223d7018285b2f15bf43e523dc398ec090792de9e2b7fa8f79bdee5'
    ) THEN
        RAISE EXCEPTION 'positive legacy version was not preserved with its exact migration values';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE id = 'aaaaaaaa-0000-0000-0000-000000000102'
            AND version = 2
            AND legacy_version = 0
            AND messages = '[{"role":"user","content":"Legacy zero"}]'::jsonb
            AND settings = '{}'::jsonb
            AND content_hash = 'e4da7ccb5ecb9f8bb2ddac243bb4c31f6a33a2651e0d4573250701c450fcddf4'
    ) THEN
        RAISE EXCEPTION 'non-positive version was not deterministically renumbered';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE id = 'cccccccc-0000-0000-0000-000000000101'
            AND version = 1
            AND legacy_version = -2
            AND content = 'Malformed {{template'
            AND messages = '[{"role":"user","content":"Malformed {{template"}]'::jsonb
            AND settings = '{}'::jsonb
            AND content_hash = '5174f14b782243ec90ce50ff3b5833cf8824d3107c09ff81d6e0b01b62b49bc1'
    ) THEN
        RAISE EXCEPTION 'malformed legacy template was not preserved read-only';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE id = 'dddddddd-0000-0000-0000-000000000101'
            AND version = 1
            AND legacy_version = 0
    ) THEN
        RAISE EXCEPTION 'zero-only prompt version was not renumbered';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE content_hash <> prompt_version_content_hash(messages, model, settings)
    ) THEN
        RAISE EXCEPTION 'a migrated prompt version has a non-canonical content hash';
    END IF;

    IF (
        SELECT count(*)
        FROM prompt_label_quarantine
        WHERE (original_project_id, original_prompt_id, original_version_id, original_label) IN (
            VALUES
                ('11111111-1111-1111-1111-111111111111'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'aaaaaaaa-0000-0000-0000-000000000101'::uuid, 'invalid!'),
                ('11111111-1111-1111-1111-111111111111'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'aaaaaaaa-0000-0000-0000-000000000101'::uuid, 'latest'),
                ('22222222-2222-2222-2222-222222222222'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'aaaaaaaa-0000-0000-0000-000000000101'::uuid, 'tenant'),
                ('11111111-1111-1111-1111-111111111111'::uuid, 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'bbbbbbbb-0000-0000-0000-000000000101'::uuid, 'version-link')
        )
    ) <> 4 THEN
        RAISE EXCEPTION 'obsolete label grammar quarantine rows were not restored';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM prompt_label_quarantine
        WHERE original_project_id = '11111111-1111-1111-1111-111111111111'
            AND original_prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            AND original_version_id = 'aaaaaaaa-0000-0000-0000-000000000101'
            AND original_label = 'invalid!'
            AND reason = 'invalid_label_format'
    ) OR NOT EXISTS (
        SELECT 1 FROM prompt_label_quarantine
        WHERE original_project_id = '11111111-1111-1111-1111-111111111111'
            AND original_prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            AND original_version_id = 'aaaaaaaa-0000-0000-0000-000000000101'
            AND original_label = 'latest'
            AND reason = 'reserved_latest'
    ) OR NOT EXISTS (
        SELECT 1 FROM prompt_label_quarantine
        WHERE original_project_id = '22222222-2222-2222-2222-222222222222'
            AND original_prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            AND original_version_id = 'aaaaaaaa-0000-0000-0000-000000000101'
            AND original_label = 'tenant'
            AND reason = 'prompt_project_mismatch'
    ) OR NOT EXISTS (
        SELECT 1 FROM prompt_label_quarantine
        WHERE original_project_id = '11111111-1111-1111-1111-111111111111'
            AND original_prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            AND original_version_id = 'bbbbbbbb-0000-0000-0000-000000000101'
            AND original_label = 'version-link'
            AND reason = 'version_prompt_mismatch'
    ) THEN
        RAISE EXCEPTION 'label quarantine reason precedence is incorrect';
    END IF;
    IF (
        SELECT count(*)
        FROM prompt_labels
        WHERE project_id = '11111111-1111-1111-1111-111111111111'
            AND prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            AND version_id = 'aaaaaaaa-0000-0000-0000-000000000101'
            AND label IN ('production', 'team_alpha')
    ) <> 2 OR NOT EXISTS (
        SELECT 1 FROM prompt_labels
        WHERE project_id = '11111111-1111-1111-1111-111111111111'
            AND prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            AND version_id = 'aaaaaaaa-0000-0000-0000-000000000101'
            AND label = 'production'
    ) OR NOT EXISTS (
        SELECT 1 FROM prompt_labels
        WHERE project_id = '11111111-1111-1111-1111-111111111111'
            AND prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            AND version_id = 'aaaaaaaa-0000-0000-0000-000000000101'
            AND label = 'team_alpha'
    ) THEN
        RAISE EXCEPTION 'valid labels were not retained and restored exactly';
    END IF;

    BEGIN
        INSERT INTO prompt_labels (project_id, prompt_id, label, version_id) VALUES
            ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001', 'tenant-link', 'aaaaaaaa-0000-0000-0000-000000000101');
        RAISE EXCEPTION 'project ownership foreign key did not reject mismatch';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO prompt_labels (project_id, prompt_id, label, version_id) VALUES
            ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'version-link', 'bbbbbbbb-0000-0000-0000-000000000101');
        RAISE EXCEPTION 'version ownership foreign key did not reject mismatch';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO prompt_labels (project_id, prompt_id, label, version_id) VALUES
            ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'latest', 'aaaaaaaa-0000-0000-0000-000000000101');
        RAISE EXCEPTION 'latest label constraint did not reject mutation';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO prompt_labels (project_id, prompt_id, label, version_id) VALUES
            ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'valid_label', 'aaaaaaaa-0000-0000-0000-000000000101');
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'new label grammar rejected underscore label';
    END;

    INSERT INTO prompt_versions (
        prompt_id,
        version,
        content,
        model,
        metadata,
        messages,
        settings,
        content_hash,
        created_by
    ) VALUES (
        'aaaaaaaa-0000-0000-0000-000000000001',
        3,
        'New',
        'new-model',
        '{}',
        '[{"role":"user","content":"New"}]',
        '{"temperature":1}',
        'not-a-hash',
        'migration-test'
    );
    IF NOT EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            AND version = 3
            AND content_hash = 'd94a92f352fb85ecf3a80de8c0ae3caad24fb8a30fb9eda9480f8ec3b3bf7e53'
            AND content_hash = prompt_version_content_hash(messages, model, settings)
    ) THEN
        RAISE EXCEPTION 'insert trigger did not store the authoritative content hash';
    END IF;
    BEGIN
        INSERT INTO prompt_versions (
            prompt_id,
            version,
            content,
            metadata,
            messages,
            settings,
            content_hash,
            created_by
        ) VALUES (
            'aaaaaaaa-0000-0000-0000-000000000001',
            4,
            'Invalid author',
            '{}',
            '[{"role":"user","content":"Invalid author"}]',
            '{}',
            'not-a-hash',
            E'\t'
        );
        RAISE EXCEPTION 'blank prompt version author was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    INSERT INTO prompt_tombstones (project_id, slug)
    VALUES ('11111111-1111-1111-1111-111111111111', 'reserved-prompt');
    BEGIN
        UPDATE prompt_tombstones SET slug = 'changed-prompt';
        RAISE EXCEPTION 'prompt tombstone accepted an update';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    BEGIN
        DELETE FROM prompt_tombstones WHERE project_id = '11111111-1111-1111-1111-111111111111' AND slug = 'reserved-prompt';
        RAISE EXCEPTION 'prompt tombstone accepted a delete';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    INSERT INTO prompt_tombstones (project_id, slug)
    VALUES ('22222222-2222-2222-2222-222222222222', 'project-reservation');
    PERFORM set_config(
        'astraea.project_deletion_id',
        '22222222-2222-2222-2222-222222222222',
        true
    );
    DELETE FROM scores
    WHERE id = 'a4000000-0000-4000-8000-000000000008';
    PERFORM set_config('astraea.project_deletion_id', '', true);
    BEGIN
        DELETE FROM projects WHERE id = '22222222-2222-2222-2222-222222222222';
        RAISE EXCEPTION 'project deletion removed a prompt tombstone';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    BEGIN
        UPDATE prompt_versions
        SET content = 'Changed'
        WHERE prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND version = 3;
        RAISE EXCEPTION 'immutable prompt version accepted an update';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;

    IF (
        SELECT messages->0->>'role'
        FROM prompt_versions
        WHERE prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
        ORDER BY version DESC
        LIMIT 1
    ) <> 'user' THEN
        RAISE EXCEPTION 'prompt role was not preserved in canonical messages';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            AND version <= 2
            AND (
                content <> messages->0->>'content'
                OR metadata <> settings
                OR change_message IS NULL
            )
    ) THEN
        RAISE EXCEPTION 'canonical version compatibility mirrors or summaries were not repaired';
    END IF;
    IF (
        SELECT array_agg(column_name::text ORDER BY ordinal_position)
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'prompt_deletion_audit'
    ) <> ARRAY['project_id', 'prompt_id', 'slug', 'deleted_by', 'deleted_at', 'deleted_version_count'] THEN
        RAISE EXCEPTION 'prompt deletion audit fields are not content-free and exact';
    END IF;
    INSERT INTO prompt_deletion_audit (project_id, prompt_id, slug, deleted_by, deleted_version_count)
    VALUES (
        '11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'first-prompt',
        'migration-test',
        2
    );
    BEGIN
        UPDATE prompt_deletion_audit SET slug = 'changed';
        RAISE EXCEPTION 'prompt deletion audit accepted an update';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    BEGIN
        DELETE FROM prompt_deletion_audit;
        RAISE EXCEPTION 'prompt deletion audit accepted a delete';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    BEGIN
        INSERT INTO prompt_versions (
            prompt_id, version, content, metadata, messages, settings, content_hash, created_by
        ) VALUES (
            'aaaaaaaa-0000-0000-0000-000000000001',
            6,
            'Missing role',
            '{}',
            '[{"content":"Missing role"}]',
            '{}',
            'not-a-hash',
            'migration-test'
        );
        RAISE EXCEPTION 'prompt version check accepted a missing role';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO prompt_versions (
            prompt_id, version, content, metadata, messages, settings, content_hash, created_by
        ) VALUES (
            'aaaaaaaa-0000-0000-0000-000000000001',
            7,
            'Missing content',
            '{}',
            '[{"role":"user"}]',
            '{}',
            'not-a-hash',
            'migration-test'
        );
        RAISE EXCEPTION 'prompt version check accepted missing content';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
            AND table_name = 'prompt_optimization_jobs'
            AND column_name = 'worker_lease_expires_at'
            AND data_type = 'timestamp with time zone'
    ) THEN
        RAISE EXCEPTION 'prompt optimization worker lease column was not created';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
            AND indexname = 'prompt_optimization_jobs_reclaimable_lease_idx'
    ) THEN
        RAISE EXCEPTION 'prompt optimization worker lease index was not created';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
            AND table_name = 'prompt_optimization_jobs'
            AND column_name IN (
                'dataset',
                'dataset_hash',
                'candidate_content',
                'evidence',
                'promotion_status',
                'promotion_reason',
                'reviewed_by',
                'promoted_at'
            )
        GROUP BY table_schema, table_name
        HAVING count(*) = 8
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_optimization_jobs'::regclass
            AND conname = 'prompt_optimization_jobs_dataset_shape_check'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_optimization_jobs'::regclass
            AND conname = 'prompt_optimization_jobs_promotion_status_check'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
            AND indexname = 'prompt_optimization_jobs_review_required_idx'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'prompt_optimization_dataset_immutable' AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'held-out optimization dataset persistence is incomplete';
    END IF;
    INSERT INTO prompt_optimization_jobs (
        id,
        project_id,
        prompt_id,
        prompt_slug,
        source_version,
        target_role,
        source_messages,
        evaluator,
        examples,
        dataset,
        dataset_hash,
        model_config,
        budget,
        status,
        requested_by
    ) VALUES (
        'aaaaaaaa-0000-4000-8000-000000000023',
        '11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'first-prompt',
        1,
        'system',
        '[{"role":"system","content":"Hello {{name}}"}]',
        '{"type":"default_adapter"}',
        '[]',
        '{"version":1,"rubric":"Preserve task deadlines.","training_examples":[{"input":"training","answer":"training label"}],"validation_examples":[{"input":"held-out","answer":"held-out label"}]}',
        repeat('a', 64),
        '{"task_lm":"task","reflection_lm":"reflection"}',
        '{"max_metric_calls":2}',
        'completed',
        'migration-test'
    );
    BEGIN
        UPDATE prompt_optimization_jobs
        SET dataset = '{"version":1,"rubric":"mutated","training_examples":[],"validation_examples":[]}'
        WHERE id = 'aaaaaaaa-0000-4000-8000-000000000023';
        RAISE EXCEPTION 'optimization dataset snapshot accepted mutation';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
            AND table_name = 'prompt_optimization_jobs'
            AND column_name = 'metric_calls_used'
            AND data_type = 'integer'
            AND is_nullable = 'YES'
    ) THEN
        RAISE EXCEPTION 'prompt optimization metric-call column was not created as nullable integer';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'prompt_optimization_jobs'::regclass
            AND conname = 'prompt_optimization_jobs_metric_calls_used_check'
            AND pg_get_constraintdef(oid) LIKE '%metric_calls_used >= 0%'
    ) THEN
        RAISE EXCEPTION 'prompt optimization metric-call check was not created';
    END IF;
	INSERT INTO prompt_optimization_jobs (
		id, project_id, prompt_id, prompt_slug, source_version, target_role,
		source_messages, evaluator, examples, dataset, dataset_hash, model_config, budget, status,
		requested_by, metric_calls_used
    )
    SELECT
        'f1000000-0000-4000-8000-000000000001',
        p.project_id,
        p.id,
        p.slug,
        1,
        'system',
		'[{"role":"system","content":"source"}]'::jsonb,
		'{}'::jsonb,
		'[]'::jsonb,
		'{"version":0,"rubric":"Legacy optimization dataset; held-out validation was not recorded.","training_examples":[],"validation_examples":[]}'::jsonb,
		repeat('b', 64),
		'{}'::jsonb,
        '{"max_metric_calls":5}'::jsonb,
        'completed',
        'migration-test',
        NULL
    FROM prompts p
    ORDER BY p.created_at, p.id
    LIMIT 1;
    IF (SELECT metric_calls_used FROM prompt_optimization_jobs WHERE id = 'f1000000-0000-4000-8000-000000000001') IS NOT NULL THEN
        RAISE EXCEPTION 'legacy prompt optimization telemetry was not preserved as unavailable';
    END IF;
    UPDATE prompt_optimization_jobs
    SET metric_calls_used = 3
    WHERE id = 'f1000000-0000-4000-8000-000000000001';
    BEGIN
        UPDATE prompt_optimization_jobs
        SET metric_calls_used = -1
        WHERE id = 'f1000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'prompt optimization metric-call check accepted a negative value';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    IF NOT EXISTS (
        SELECT 1
        FROM organizations
        WHERE id = '00000000-0000-4000-8000-000000000001'
            AND slug = 'default'
    ) THEN
        RAISE EXCEPTION 'default organization was not seeded';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM projects
        WHERE id IN (
            '11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
            '44444444-4444-4444-8444-444444444444'
        )
            AND organization_id <> '00000000-0000-4000-8000-000000000001'
    ) THEN
        RAISE EXCEPTION 'legacy projects were not backfilled to the default organization';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
            AND column_name IN ('organization_id', 'project_id')
            AND (table_name, column_name) NOT IN (
                ('authorization_role_migration_audit', 'project_id'),
                ('authorization_role_migration_quarantine', 'project_id'),
                ('admin_access_audit_events', 'project_id')
            )
            AND is_nullable <> 'NO'
    ) THEN
        RAISE EXCEPTION 'tenant identifier columns must be NOT NULL';
    END IF;
    BEGIN
        INSERT INTO projects (name, slug, organization_id)
        VALUES ('Invalid Organization Project', 'invalid-organization', '00000000-0000-4000-8000-000000000099');
        RAISE EXCEPTION 'project organization foreign key accepted an unknown organization';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;

    ALTER TABLE organizations ALTER COLUMN default_project_id DROP NOT NULL;
    INSERT INTO organizations (id, name, slug)
    VALUES ('00000000-0000-4000-8000-000000000002', 'Second Organization', 'second')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO projects (id, name, slug, organization_id)
    VALUES (
        '33333333-3333-4333-8333-333333333333',
        'Second Organization Default',
        'default',
        '00000000-0000-4000-8000-000000000002'
    );
    UPDATE organizations
    SET default_project_id = '33333333-3333-4333-8333-333333333333'
    WHERE id = '00000000-0000-4000-8000-000000000002';
    ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;
    IF NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE organization_id = '00000000-0000-4000-8000-000000000001'
            AND slug = 'default'
    ) OR NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE id = '33333333-3333-4333-8333-333333333333'
            AND organization_id = '00000000-0000-4000-8000-000000000002'
            AND slug = 'default'
    ) THEN
        RAISE EXCEPTION 'project slugs are not organization-scoped';
    END IF;

    IF (
        NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%added_to_dataset%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%dataset_id IS NULL%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND conname = 'feedback_reviews_dataset_version_item_project_fk'
            AND pg_get_constraintdef(oid) LIKE '%FOREIGN KEY (dataset_item_id, project_id)%'
            AND pg_get_constraintdef(oid) LIKE '%REFERENCES dataset_version_items(id, project_id)%'
            AND pg_get_constraintdef(oid) LIKE '%ON DELETE RESTRICT%'
    ) OR EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND contype = 'f'
            AND pg_get_constraintdef(oid) LIKE '%dataset_items%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_idempotency'::regclass
            AND contype = 'p'
            AND pg_get_constraintdef(oid) LIKE '%project_id, idempotency_key%'
    ) OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'feedback_reviews'::regclass AND contype = 'f') < 4
        OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'feedback_idempotency'::regclass AND contype = 'f') < 2
    ) THEN
        RAISE EXCEPTION 'feedback constraints or idempotency uniqueness are incomplete';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_scores_feedback_target')
        OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_feedback_reviews_project_status')
        OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'scores_human_feedback_immutable' AND NOT tgisinternal) THEN
        RAISE EXCEPTION 'feedback indexes or immutability trigger are incomplete';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dataset_items' AND column_name = 'feedback_score_id'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'dataset_items_feedback_score_id_unique'
            AND indexdef LIKE 'CREATE UNIQUE INDEX%'
    ) THEN
        RAISE EXCEPTION 'feedback promotion idempotency constraint is incomplete';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND conname = 'feedback_reviews_score_project_fk'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND conname = 'feedback_reviews_dataset_project_fk'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND conname = 'feedback_reviews_dataset_draft_item_project_fk'
    ) THEN
        RAISE EXCEPTION 'feedback project scope constraints are incomplete';
    END IF;

    INSERT INTO datasets (id, project_id, slug, name) VALUES
        ('a1000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'feedback-scope-a', 'feedback-scope-a'),
        ('a2000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'feedback-scope-b', 'feedback-scope-b'),
        ('b1000000-0000-4000-8000-000000000001', '22222222-2222-2222-2222-222222222222', 'feedback-scope-other', 'feedback-scope-other');
    INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash) VALUES
        ('a1000000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'a1000000-0000-4000-8000-000000000001', 1, 1, repeat('a', 64)),
        ('a2000000-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'a2000000-0000-4000-8000-000000000001', 1, 1, repeat('b', 64)),
        ('b1000000-0000-4000-8000-000000000003', '22222222-2222-2222-2222-222222222222', 'b1000000-0000-4000-8000-000000000001', 1, 1, repeat('c', 64));
    INSERT INTO dataset_version_items (id, project_id, dataset_version_id, item_key, position, input) VALUES
        ('a1000000-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', 'a1000000-0000-4000-8000-000000000003', 'feedback-scope-a', 0, '{}'),
        ('a2000000-0000-4000-8000-000000000004', '11111111-1111-1111-1111-111111111111', 'a2000000-0000-4000-8000-000000000003', 'feedback-scope-b', 0, '{}'),
        ('b1000000-0000-4000-8000-000000000004', '22222222-2222-2222-2222-222222222222', 'b1000000-0000-4000-8000-000000000003', 'feedback-scope-other', 0, '{}');
    INSERT INTO scores (id, project_id, trace_id, name, value, metadata) VALUES
        ('c1000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'feedback-scope-score-1', 'human.feedback', -1, '{}'),
        ('c2000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'feedback-scope-score-2', 'human.feedback', -1, '{}'),
        ('c3000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'feedback-scope-score-3', 'human.feedback', -1, '{}');
    BEGIN
        INSERT INTO feedback_reviews (score_id, project_id, status)
        VALUES ('c1000000-0000-4000-8000-000000000001', '22222222-2222-2222-2222-222222222222', 'new');
        RAISE EXCEPTION 'feedback review accepted a score from another project';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO feedback_reviews (score_id, project_id, status, dataset_id, dataset_item_id)
        VALUES (
            'c2000000-0000-4000-8000-000000000001',
            '11111111-1111-1111-1111-111111111111',
            'added_to_dataset',
            'b1000000-0000-4000-8000-000000000001',
            'b1000000-0000-4000-8000-000000000004'
        );
        RAISE EXCEPTION 'feedback review accepted a dataset from another project';
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
        NULL;
    END;
	INSERT INTO scores (id, project_id, trace_id, name, value, metadata)
	VALUES ('99999999-9999-4999-8999-999999999999', '11111111-1111-1111-1111-111111111111', 'feedback-trace', 'human.feedback', -1, '{}');
	INSERT INTO feedback_reviews (score_id, project_id, status)
	VALUES (
		'c1000000-0000-4000-8000-000000000001',
		'11111111-1111-1111-1111-111111111111',
		'reviewed'
	);
	INSERT INTO actors (id) VALUES ('a1000000-0000-4000-8000-000000000012');
	INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
	SELECT
		'a1000000-0000-4000-8000-000000000012',
		organization_id,
		'basic:v1',
		'deletion-order-requester'
	FROM projects
	WHERE id = '11111111-1111-1111-1111-111111111111';
	UPDATE datasets
	SET latest_published_version = 1
	WHERE id = 'a1000000-0000-4000-8000-000000000001';
	INSERT INTO dataset_drafts (id, project_id, dataset_id, base_version, revision, created_by)
	SELECT
		'a1000000-0000-4000-8000-000000000008',
		project_id,
		id,
		latest_published_version,
		2,
		'a1000000-0000-4000-8000-000000000012'
	FROM datasets
	WHERE id = 'a1000000-0000-4000-8000-000000000001';
	INSERT INTO dataset_draft_items (id, project_id, draft_id, item_key, position, input, feedback_score_id)
	VALUES (
		'a1000000-0000-4000-8000-000000000009',
		'11111111-1111-1111-1111-111111111111',
		'a1000000-0000-4000-8000-000000000008',
		'feedback-scope-score-1',
		0,
		'{}',
		'c1000000-0000-4000-8000-000000000001'
	);
	UPDATE feedback_reviews
	SET status = 'added_to_dataset',
		dataset_id = 'a1000000-0000-4000-8000-000000000001',
		dataset_draft_item_id = 'a1000000-0000-4000-8000-000000000009'
	WHERE score_id = 'c1000000-0000-4000-8000-000000000001';
	IF NOT EXISTS (
		SELECT 1
		FROM feedback_reviews review
		JOIN dataset_draft_items item ON item.id = review.dataset_draft_item_id
		WHERE review.score_id = 'c1000000-0000-4000-8000-000000000001'
			AND review.status = 'added_to_dataset'
			AND item.feedback_score_id = review.score_id
			AND item.project_id = review.project_id
	) THEN
		RAISE EXCEPTION 'feedback promotion did not retain the reviewed score through its project-scoped draft item';
	END IF;
	INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash, created_via)
	VALUES (
		'a1000000-0000-4000-8000-000000000010',
		'11111111-1111-1111-1111-111111111111',
		'a1000000-0000-4000-8000-000000000001',
		2,
		1,
		repeat('d', 64),
		'draft_publish'
	);
	INSERT INTO dataset_version_items (id, project_id, dataset_version_id, item_key, position, input)
	SELECT
		'a1000000-0000-4000-8000-000000000011',
		item.project_id,
		'a1000000-0000-4000-8000-000000000010',
		item.item_key,
		item.position,
		item.input
	FROM dataset_draft_items item
	WHERE item.id = 'a1000000-0000-4000-8000-000000000009';
	UPDATE datasets
	SET latest_published_version = 2
	WHERE id = 'a1000000-0000-4000-8000-000000000001';
	UPDATE feedback_reviews
	SET dataset_draft_item_id = NULL,
		dataset_item_id = 'a1000000-0000-4000-8000-000000000011'
	WHERE score_id = 'c1000000-0000-4000-8000-000000000001';
	DELETE FROM dataset_drafts WHERE id = 'a1000000-0000-4000-8000-000000000008';
	INSERT INTO benchmark_suites (id, project_id, dataset_id, name)
	VALUES (
		'd1000000-0000-4000-8000-000000000001',
		'11111111-1111-1111-1111-111111111111',
		'a1000000-0000-4000-8000-000000000001',
		'deletion-order-suite'
	);
	INSERT INTO agents (id, project_id, name)
	VALUES (
		'a1000000-0000-4000-8000-000000000005',
		'11111111-1111-1111-1111-111111111111',
		'deletion-order-agent'
	);
	INSERT INTO experiments (id, project_id, agent_id, dataset_id, status, config, requested_by_actor_id)
	VALUES (
		'a1000000-0000-4000-8000-000000000006',
		'11111111-1111-1111-1111-111111111111',
		'a1000000-0000-4000-8000-000000000005',
		'a1000000-0000-4000-8000-000000000001',
		'pending',
		'{}',
		'a1000000-0000-4000-8000-000000000012'
	);
	INSERT INTO benchmark_runs (id, project_id, suite_id, experiment_id, label)
	VALUES (
		'd2000000-0000-4000-8000-000000000001',
		'11111111-1111-1111-1111-111111111111',
		'd1000000-0000-4000-8000-000000000001',
		'a1000000-0000-4000-8000-000000000006',
		'deletion-order-run'
	);
	IF NOT EXISTS (
		SELECT 1 FROM feedback_reviews review
		JOIN dataset_version_items item ON item.id = review.dataset_item_id
		JOIN dataset_versions version ON version.id = item.dataset_version_id
		WHERE review.score_id = 'c1000000-0000-4000-8000-000000000001'
			AND review.project_id = '11111111-1111-1111-1111-111111111111'
			AND review.status = 'added_to_dataset'
			AND review.dataset_id = 'a1000000-0000-4000-8000-000000000001'
			AND review.dataset_item_id = 'a1000000-0000-4000-8000-000000000011'
			AND item.project_id = review.project_id
			AND item.item_key = 'feedback-scope-score-1'
			AND version.id = 'a1000000-0000-4000-8000-000000000010'
			AND version.dataset_id = review.dataset_id
	) OR NOT EXISTS (
		SELECT 1 FROM benchmark_runs run
		JOIN benchmark_suites suite ON suite.id = run.suite_id
		WHERE run.id = 'd2000000-0000-4000-8000-000000000001'
			AND run.project_id = '11111111-1111-1111-1111-111111111111'
			AND run.experiment_id = 'a1000000-0000-4000-8000-000000000006'
			AND suite.id = 'd1000000-0000-4000-8000-000000000001'
			AND suite.project_id = '11111111-1111-1111-1111-111111111111'
			AND suite.dataset_id = 'a1000000-0000-4000-8000-000000000001'
	) OR NOT EXISTS (
		SELECT 1
		FROM experiments experiment
		JOIN actor_identities identity ON identity.actor_id = experiment.requested_by_actor_id
		JOIN projects project ON project.id = experiment.project_id
		WHERE experiment.id = 'a1000000-0000-4000-8000-000000000006'
			AND experiment.status = 'pending'
			AND identity.organization_id = project.organization_id
			AND identity.provider_namespace = 'basic:v1'
	) THEN
		RAISE EXCEPTION 'deletion dependency fixtures for promoted feedback or benchmark suites are incomplete';
	END IF;
	BEGIN
        UPDATE scores SET value = 1 WHERE id = '99999999-9999-4999-8999-999999999999';
        RAISE EXCEPTION 'human feedback score accepted a mutation';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> 'P0001' THEN RAISE; END IF;
    END;
    IF NOT EXISTS (
        SELECT 1 FROM experiment_tasks
        WHERE experiment_id = 'a6000000-0000-4000-8000-000000000001'
            AND dataset_item_id = 'a5000000-0000-4000-8000-000000000001'
            AND status = 'completed' AND completed_at IS NOT NULL
    ) OR NOT EXISTS (
        SELECT 1 FROM experiment_tasks
        WHERE experiment_id = 'a6000000-0000-4000-8000-000000000001'
            AND dataset_item_id = 'a5000000-0000-4000-8000-000000000002'
            AND status = 'pending'
    ) OR NOT EXISTS (
        SELECT 1 FROM experiments
        WHERE id = 'a6000000-0000-4000-8000-000000000001' AND status = 'completed'
    ) THEN
        RAISE EXCEPTION 'experiment task backfill did not preserve completed results';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'experiment_tasks'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'experiment_tasks'::regclass AND contype = 'u'
            AND pg_get_constraintdef(oid) LIKE '%experiment_id, dataset_item_id%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'experiment_results'::regclass AND contype = 'u'
            AND pg_get_constraintdef(oid) LIKE '%experiment_id, dataset_item_id%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'experiment_tasks_claimable_idx'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'experiments_seed_tasks' AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'durable experiment task ledger is incomplete';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'experiment_tasks'
            AND column_name = 'dataset_version_item_id'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'experiment_results'
            AND column_name = 'dataset_version_item_id'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'experiment_tasks'::regclass
            AND conname = 'experiment_tasks_one_item_identity'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
            AND indexname = 'experiment_tasks_version_item_key'
    ) OR pg_get_functiondef('seed_experiment_tasks'::regproc) NOT LIKE '%dataset_version_item_id%'
        OR pg_get_functiondef('seed_experiment_tasks'::regproc) LIKE '%FROM dataset_items%' THEN
        RAISE EXCEPTION 'experiment task seeding does not use immutable dataset snapshots';
    END IF;

    IF (
        SELECT count(*)
        FROM project_memberships AS pm
        WHERE pm.organization_id = '00000000-0000-4000-8000-000000000001'
            AND pm.actor_subject = 'bootstrap-owner'
            AND pm.role = 'manager'
            AND (
                pm.project_id IN (
                    '11111111-1111-1111-1111-111111111111',
                    '22222222-2222-2222-2222-222222222222',
                    '44444444-4444-4444-8444-444444444444'
                ) OR pm.project_id = (
                    SELECT default_project_id
                    FROM organizations
                    WHERE id = '00000000-0000-4000-8000-000000000001'
                )
            )
    ) <> 4
        OR EXISTS (
            SELECT 1 FROM projects p
            WHERE p.organization_id = '00000000-0000-4000-8000-000000000001'
                AND (
                    p.id IN (
                        '11111111-1111-1111-1111-111111111111',
                        '22222222-2222-2222-2222-222222222222',
                        '44444444-4444-4444-8444-444444444444'
                    ) OR p.id = (
                        SELECT default_project_id
                        FROM organizations
                        WHERE id = '00000000-0000-4000-8000-000000000001'
                    )
                )
                AND NOT EXISTS (
                    SELECT 1 FROM project_memberships pm
                    WHERE pm.project_id = p.id AND pm.actor_subject = 'bootstrap-owner' AND pm.role = 'manager'
                )
        )
        OR NOT EXISTS (
            SELECT 1 FROM organization_memberships
            WHERE organization_id = '00000000-0000-4000-8000-000000000001'
                AND actor_subject = 'bootstrap-owner' AND role = 'owner'
        )
        OR EXISTS (
            SELECT 1
            FROM projects AS p
            WHERE p.organization_id = '00000000-0000-4000-8000-000000000001'
                AND (
                    p.id IN (
                        '11111111-1111-1111-1111-111111111111',
                        '22222222-2222-2222-2222-222222222222',
                        '44444444-4444-4444-8444-444444444444'
                    ) OR p.id = (
                        SELECT default_project_id
                        FROM organizations
                        WHERE id = '00000000-0000-4000-8000-000000000001'
                    )
                )
                AND NOT EXISTS (
                    SELECT 1
                    FROM project_authorization_audit_events AS event
                    WHERE event.organization_id = '00000000-0000-4000-8000-000000000001'
                        AND event.project_id = p.id
                        AND event.actor_subject = 'bootstrap-owner'
                        AND event.event_type = 'bootstrap_manager_added'
                )
        )
        OR (
            SELECT count(*)
            FROM project_authorization_audit_events
            WHERE organization_id = '00000000-0000-4000-8000-000000000001'
                AND actor_subject = 'bootstrap-owner'
                AND event_type = 'bootstrap_manager_added'
                AND (
                    project_id IN (
                        '11111111-1111-1111-1111-111111111111',
                        '22222222-2222-2222-2222-222222222222',
                        '44444444-4444-4444-8444-444444444444'
                    ) OR project_id = (
                        SELECT default_project_id
                        FROM organizations
                        WHERE id = '00000000-0000-4000-8000-000000000001'
                    )
                )
        ) <> 4 THEN
        RAISE EXCEPTION 'bootstrap owner was not idempotently granted manager membership for every historical project';
    END IF;

    INSERT INTO organization_memberships (organization_id, actor_subject, role)
    VALUES ('00000000-0000-4000-8000-000000000002', 'migration-owner', 'owner');
    UPDATE organization_memberships
    SET role = 'owner'
    WHERE organization_id = '00000000-0000-4000-8000-000000000002'
        AND actor_subject = 'migration-owner';
    BEGIN
        UPDATE organization_memberships
        SET role = 'member'
        WHERE organization_id = '00000000-0000-4000-8000-000000000002'
            AND actor_subject = 'migration-owner';
        RAISE EXCEPTION 'final organization owner demotion was accepted';
    EXCEPTION WHEN raise_exception THEN
        NULL;
    END;
    BEGIN
        UPDATE organization_memberships
        SET organization_id = '00000000-0000-4000-8000-000000000001'
        WHERE organization_id = '00000000-0000-4000-8000-000000000002'
            AND actor_subject = 'migration-owner';
        RAISE EXCEPTION 'sole organization owner membership move was accepted';
    EXCEPTION WHEN raise_exception THEN
        NULL;
    END;

    INSERT INTO organization_memberships (organization_id, actor_subject, role)
    VALUES ('00000000-0000-4000-8000-000000000002', 'migration-manager', 'member');
    INSERT INTO project_memberships (project_id, organization_id, actor_subject, role)
    VALUES ('33333333-3333-4333-8333-333333333333', '00000000-0000-4000-8000-000000000002', 'migration-manager', 'manager');
    UPDATE project_memberships
    SET role = 'manager'
    WHERE project_id = '33333333-3333-4333-8333-333333333333'
        AND actor_subject = 'migration-manager';
    BEGIN
        UPDATE project_memberships
        SET role = 'member'
        WHERE project_id = '33333333-3333-4333-8333-333333333333'
            AND actor_subject = 'migration-manager';
        RAISE EXCEPTION 'final active project manager demotion was accepted';
    EXCEPTION WHEN raise_exception THEN
        NULL;
    END;
    BEGIN
        UPDATE project_memberships
        SET project_id = '55555555-5555-4555-8555-555555555555'
        WHERE project_id = '33333333-3333-4333-8333-333333333333'
            AND actor_subject = 'migration-manager';
        RAISE EXCEPTION 'sole active project manager membership move was accepted';
    EXCEPTION WHEN raise_exception THEN
        NULL;
    END;

    INSERT INTO organization_memberships (organization_id, actor_subject, role)
    VALUES ('00000000-0000-4000-8000-000000000002', 'archived-member', 'member');
    INSERT INTO projects (id, name, slug, organization_id, status)
    VALUES (
        '55555555-5555-4555-8555-555555555555',
        'Managerless Archived Project',
        'managerless-archived',
        '00000000-0000-4000-8000-000000000002',
        'archived'
    );
    BEGIN
        UPDATE projects SET status = 'active'
        WHERE id = '55555555-5555-4555-8555-555555555555';
        RAISE EXCEPTION 'managerless archived project was restored';
    EXCEPTION WHEN raise_exception THEN
        NULL;
    END;

    INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type)
    VALUES (
        '00000000-0000-4000-8000-000000000002',
        '33333333-3333-4333-8333-333333333333',
        'migration-owner',
        'project_updated'
    );
    INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type)
    VALUES (
        '00000000-0000-4000-8000-000000000002',
        '33333333-3333-4333-8333-333333333333',
        'migration-owner',
        'project_work_cancelled'
    );
    BEGIN
        INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type)
        VALUES (
            '00000000-0000-4000-8000-000000000001',
            '33333333-3333-4333-8333-333333333333',
            'migration-owner',
            'project_updated'
        );
        RAISE EXCEPTION 'authorization audit accepted a cross-organization project';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    BEGIN
        UPDATE project_authorization_audit_events SET event_type = 'project_archived'
        WHERE project_id = '33333333-3333-4333-8333-333333333333';
        RAISE EXCEPTION 'authorization audit accepted an update';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
	BEGIN
		DELETE FROM project_authorization_audit_events
		WHERE project_id = '33333333-3333-4333-8333-333333333333';
		RAISE EXCEPTION 'authorization audit accepted a delete';
	EXCEPTION WHEN SQLSTATE '55000' THEN
		NULL;
	END;
	INSERT INTO project_lifecycle_audit_events (organization_id, project_id, actor_subject, event_type, result)
	VALUES (
		'00000000-0000-4000-8000-000000000002',
		'33333333-3333-4333-8333-333333333333',
		'migration-owner',
		'deletion_attempted',
		'{"stage":"started"}'
	);
	BEGIN
		UPDATE project_lifecycle_audit_events
		SET event_type = 'deletion_failed', result = '{"stage":"changed"}'
		WHERE project_id = '33333333-3333-4333-8333-333333333333';
		RAISE EXCEPTION 'lifecycle audit accepted an update';
	EXCEPTION WHEN SQLSTATE '55000' THEN
		NULL;
	END;
	BEGIN
		DELETE FROM project_lifecycle_audit_events
		WHERE project_id = '33333333-3333-4333-8333-333333333333';
		RAISE EXCEPTION 'lifecycle audit accepted a delete';
	EXCEPTION WHEN SQLSTATE '55000' THEN
		NULL;
	END;
END
$$;

DO $$
DECLARE
    test_organization_id CONSTANT UUID := '00000000-0000-4000-8000-000000000002';
    test_project_id CONSTANT UUID := 'abababab-abab-4bab-8bab-abababababab';
    test_actor_subject CONSTANT TEXT := 'project-deletion-lifecycle-user';
BEGIN
    INSERT INTO organization_memberships (organization_id, actor_subject, role)
    VALUES (test_organization_id, test_actor_subject, 'member');
    INSERT INTO projects (id, name, slug, organization_id)
    VALUES (
        test_project_id,
        'Project Deletion Lifecycle Guard',
        'project-deletion-lifecycle-guard',
        test_organization_id
    );
    INSERT INTO project_memberships (project_id, organization_id, actor_subject, role)
    VALUES (test_project_id, test_organization_id, test_actor_subject, 'manager');

    IF NOT EXISTS (
        SELECT 1
        FROM projects AS project
        JOIN organizations AS organization ON organization.id = project.organization_id
        WHERE project.id = test_project_id
          AND project.organization_id = test_organization_id
          AND project.id <> organization.default_project_id
          AND project.status = 'active'
    ) OR (
        SELECT count(*)
        FROM project_memberships
        WHERE project_id = test_project_id
          AND role = 'manager'
    ) <> 1 THEN
        RAISE EXCEPTION 'project deletion lifecycle fixture is not an active non-default project with one User';
    END IF;

    PERFORM set_config('astraea.project_deletion_id', test_project_id::text, true);
    BEGIN
        UPDATE project_memberships
        SET role = 'member'
        WHERE project_id = test_project_id
          AND actor_subject = test_actor_subject;
        RAISE EXCEPTION 'project deletion context demoted the final active project User';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'cannot remove or demote the final active project User' THEN
            RAISE;
        END IF;
    END;
    BEGIN
        DELETE FROM project_memberships
        WHERE project_id = test_project_id
          AND actor_subject = test_actor_subject;
        RAISE EXCEPTION 'project deletion context removed the final active project User';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'cannot remove or demote the final active project User' THEN
            RAISE;
        END IF;
    END;
    IF NOT EXISTS (
        SELECT 1
        FROM project_memberships
        WHERE project_id = test_project_id
          AND actor_subject = test_actor_subject
          AND role = 'manager'
    ) THEN
        RAISE EXCEPTION 'active project final User guard did not preserve its membership';
    END IF;
    BEGIN
        UPDATE organization_memberships
        SET role = 'member'
        WHERE organization_id = test_organization_id
          AND actor_subject = 'migration-owner';
        RAISE EXCEPTION 'project deletion context demoted the final organization Admin';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'cannot remove or demote the final organization Admin' THEN
            RAISE;
        END IF;
    END;
    BEGIN
        DELETE FROM organization_memberships
        WHERE organization_id = test_organization_id
          AND actor_subject = 'migration-owner';
        RAISE EXCEPTION 'project deletion context removed the final organization Admin';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'cannot remove or demote the final organization Admin' THEN
            RAISE;
        END IF;
    END;
    IF NOT EXISTS (
        SELECT 1
        FROM organization_memberships
        WHERE organization_id = test_organization_id
          AND actor_subject = 'migration-owner'
          AND role = 'owner'
    ) THEN
        RAISE EXCEPTION 'final organization Admin guard did not preserve its membership';
    END IF;

    PERFORM set_config('astraea.project_deletion_id', '', true);
    IF current_setting('astraea.project_deletion_id', true) IS DISTINCT FROM '' THEN
        RAISE EXCEPTION 'project deletion context was not cleared before deleting cleanup';
    END IF;

    UPDATE projects
    SET status = 'deleting'
    WHERE id = test_project_id;
    DELETE FROM project_memberships
    WHERE project_id = test_project_id
      AND actor_subject = test_actor_subject;
    IF EXISTS (
        SELECT 1
        FROM project_memberships
        WHERE project_id = test_project_id
    ) THEN
        RAISE EXCEPTION 'deleting project did not clean up its User membership';
    END IF;
    DELETE FROM projects
    WHERE id = test_project_id;
    IF EXISTS (SELECT 1 FROM projects WHERE id = test_project_id) THEN
        RAISE EXCEPTION 'deleting non-default project was not removed after membership cleanup';
    END IF;
END
$$;

DO $$
DECLARE
    dataset_project_id UUID := '55555555-5555-4555-8555-555555555556';
    other_project_id UUID := '55555555-5555-4555-8555-555555555557';
    fixture_dataset_id UUID := '55555555-5555-4555-8555-555555555558';
    other_dataset_id UUID := '55555555-5555-4555-8555-555555555559';
    untrusted_actor_id UUID := '51000000-0000-4000-8000-000000000104';
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'dataset_lifecycle_audit_events'::regclass
            AND conname = 'dataset_lifecycle_audit_events_dataset_project_fkey'
    ) THEN
        RAISE EXCEPTION 'dataset lifecycle audit must retain historical identity after retention';
    END IF;
    INSERT INTO projects (id, name, slug, organization_id)
    VALUES
        (dataset_project_id, 'Dataset Retention Fixture', 'dataset-retention-fixture', '51000000-0000-4000-8000-000000000001'),
        (other_project_id, 'Other Dataset Fixture', 'other-dataset-fixture', '51000000-0000-4000-8000-000000000002');
    INSERT INTO datasets (id, project_id, slug, name)
    VALUES (fixture_dataset_id, dataset_project_id, 'retained-dataset', 'Retained Dataset');
    INSERT INTO datasets (id, project_id, slug, name)
    VALUES (other_dataset_id, other_project_id, 'other-retained-dataset', 'Other Retained Dataset');
    INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type)
    VALUES ('51000000-0000-4000-8000-000000000001', dataset_project_id, fixture_dataset_id, 'retained-dataset', '51000000-0000-4000-8000-000000000101', 'archived');
    INSERT INTO actors (id) VALUES (untrusted_actor_id);
    INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
    VALUES (untrusted_actor_id, '51000000-0000-4000-8000-000000000001', 'test:v1', 'untrusted-dataset-audit-actor');
    BEGIN
        INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type)
        VALUES ('51000000-0000-4000-8000-000000000001', dataset_project_id, fixture_dataset_id, 'retained-dataset', untrusted_actor_id, 'created');
        RAISE EXCEPTION 'dataset lifecycle audit accepted an unauthorized actor';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    BEGIN
        INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type)
        VALUES ('51000000-0000-4000-8000-000000000002', other_project_id, fixture_dataset_id, 'retained-dataset', '51000000-0000-4000-8000-000000000101', 'created');
        RAISE EXCEPTION 'dataset lifecycle audit accepted a cross-project dataset';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO dataset_lifecycle_audit_events (organization_id, project_id, dataset_id, slug, actor_id, event_type)
        VALUES ('51000000-0000-4000-8000-000000000002', other_project_id, other_dataset_id, 'other-retained-dataset', '51000000-0000-4000-8000-000000000101', 'created');
        RAISE EXCEPTION 'dataset lifecycle audit accepted a cross-organization actor';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    BEGIN
        DELETE FROM dataset_lifecycle_audit_events WHERE dataset_id = fixture_dataset_id;
        RAISE EXCEPTION 'dataset lifecycle audit accepted an ordinary delete';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    PERFORM set_config('astraea.dataset_retention_project_id', dataset_project_id::text, true);
    BEGIN
        DELETE FROM dataset_lifecycle_audit_events WHERE dataset_id = fixture_dataset_id;
        RAISE EXCEPTION 'dataset retention context deleted append-only lifecycle evidence';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    INSERT INTO dataset_tombstones (project_id, slug)
    VALUES (dataset_project_id, 'retained-dataset');
    PERFORM set_config('astraea.project_deletion_id', dataset_project_id::text, true);
    DELETE FROM dataset_lifecycle_audit_events WHERE project_id = dataset_project_id;
    DELETE FROM dataset_tombstones WHERE project_id = dataset_project_id;
    DELETE FROM datasets WHERE project_id = dataset_project_id;
    DELETE FROM projects WHERE id = dataset_project_id;
    DELETE FROM datasets WHERE project_id = other_project_id;
    DELETE FROM projects WHERE id = other_project_id;
    DELETE FROM actor_identities WHERE actor_id = untrusted_actor_id;
    DELETE FROM actors WHERE id = untrusted_actor_id;
END
$$;

DO $$
DECLARE
    deletion_project_id UUID := '77777777-7777-4777-8777-777777777777';
BEGIN
    INSERT INTO projects (id, name, slug, organization_id)
    VALUES (
        deletion_project_id,
        'Permanent Deletion Fixture',
        'permanent-deletion-fixture',
        '00000000-0000-4000-8000-000000000001'
    );
    INSERT INTO prompt_tombstones (project_id, slug)
    VALUES (deletion_project_id, 'permanent-deletion-fixture');
    INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type)
    VALUES ('00000000-0000-4000-8000-000000000001', deletion_project_id, 'migration-deletion', 'project_created');
    BEGIN
        DELETE FROM prompt_tombstones WHERE project_id = deletion_project_id;
        RAISE EXCEPTION 'project deletion escape was available without transaction-local authorization';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    PERFORM set_config('astraea.project_deletion_id', deletion_project_id::text, true);
    DELETE FROM prompt_tombstones WHERE project_id = deletion_project_id;
    IF EXISTS (SELECT 1 FROM prompt_tombstones WHERE project_id = deletion_project_id) THEN
        RAISE EXCEPTION 'project deletion escape did not remove the scoped tombstone';
    END IF;
    DELETE FROM projects WHERE id = deletion_project_id;
	INSERT INTO project_lifecycle_audit_events (organization_id, project_id, actor_subject, event_type, result)
	VALUES (
		'00000000-0000-4000-8000-000000000001',
		deletion_project_id,
		'migration-deletion',
		'deletion_completed',
		'{"stage":"completed"}'
	);
    IF NOT EXISTS (
        SELECT 1
        FROM project_authorization_audit_events
        WHERE organization_id = '00000000-0000-4000-8000-000000000001'
            AND project_id = deletion_project_id
            AND actor_subject = 'migration-deletion'
    ) THEN
        RAISE EXCEPTION 'project deletion did not retain authorization audit provenance';
    END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM project_lifecycle_audit_events
		WHERE organization_id = '00000000-0000-4000-8000-000000000001'
			AND project_id = deletion_project_id
			AND event_type = 'deletion_completed'
	) THEN
		RAISE EXCEPTION 'project deletion did not retain lifecycle audit provenance';
	END IF;
    ALTER TABLE organizations ALTER COLUMN default_project_id DROP NOT NULL;
    INSERT INTO organizations (id, name, slug)
    VALUES ('88888888-8888-4888-8888-888888888888', 'UUID Reuse Test Organization', 'uuid-reuse-test');
    INSERT INTO projects (id, name, slug, organization_id)
    VALUES ('88888888-8888-4888-8888-888888888889', 'UUID Reuse Default Project', 'default', '88888888-8888-4888-8888-888888888888');
    UPDATE organizations
    SET default_project_id = '88888888-8888-4888-8888-888888888889'
    WHERE id = '88888888-8888-4888-8888-888888888888';
    ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;
    BEGIN
        INSERT INTO projects (id, name, slug, organization_id)
        VALUES (deletion_project_id, 'Reused Project', 'reused-project', '88888888-8888-4888-8888-888888888888');
        RAISE EXCEPTION 'retained audit provenance allowed project UUID reuse in another organization';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END
$$;

DO $$
DECLARE
    version_id UUID := '99999999-0000-4000-8000-000000000001';
BEGIN
    INSERT INTO projects (id, name, slug, organization_id) VALUES ('99999999-0000-4000-8000-000000000011', 'Governance Test Project', 'governance-test', '88888888-8888-4888-8888-888888888888') ON CONFLICT DO NOTHING;
    INSERT INTO governance_policies (id, organization_id, project_id) VALUES ('99999999-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
    INSERT INTO governance_policy_versions (id, policy_id, organization_id, project_id, version, retention, redaction, content_hash, created_by) VALUES (version_id, '99999999-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 1, '{}', '{"mode":"none","keys":[]}', repeat('a', 64), 'migration-test') ON CONFLICT DO NOTHING;
    BEGIN
        INSERT INTO governance_policy_approvals (policy_version_id, organization_id, project_id, actor_subject) VALUES (version_id, '88888888-8888-4888-8888-888888888888', '99999999-0000-4000-8000-000000000011', 'migration-test');
        RAISE EXCEPTION 'governance approval provenance mismatch was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type) VALUES ('88888888-8888-4888-8888-888888888888', '99999999-0000-4000-8000-000000000011', version_id, 'migration-test', 'policy_created');
        RAISE EXCEPTION 'governance audit provenance mismatch was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO governance_retention_runs (organization_id, project_id, policy_version_id, requested_by, status, owner_token, heartbeat_at, lease_expires_at) VALUES ('88888888-8888-4888-8888-888888888888', '99999999-0000-4000-8000-000000000011', version_id, 'migration-test', 'running', gen_random_uuid(), now(), now() + interval '5 minutes');
        RAISE EXCEPTION 'governance retention provenance mismatch was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    INSERT INTO governance_audit_events (organization_id, project_id, policy_version_id, actor_subject, event_type)
    VALUES ('00000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', version_id, 'migration-test', 'policy_created');
    PERFORM set_config('astraea.project_deletion_id', '11111111-1111-1111-1111-111111111111', true);
    DELETE FROM governance_policy_versions WHERE id = version_id;
    IF NOT EXISTS (
        SELECT 1 FROM governance_audit_events
        WHERE organization_id = '00000000-0000-4000-8000-000000000001'
            AND project_id = '11111111-1111-1111-1111-111111111111'
            AND policy_version_id IS NULL
            AND actor_subject = 'migration-test'
    ) THEN
        RAISE EXCEPTION 'policy version deletion did not retain governance audit tenant provenance';
    END IF;
END
$$;
