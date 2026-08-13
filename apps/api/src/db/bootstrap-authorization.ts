import { Pool } from "pg";
import { basicCredentialsFromEnvironment } from "../middleware/auth.js";

export async function bootstrapAuthorization(
	env: NodeJS.ProcessEnv = process.env,
	pool = new Pool({ connectionString: env.DATABASE_URL }),
): Promise<void> {
	const username = env.ASTRAEA_BOOTSTRAP_OWNER_USERNAME;
	if (!username)
		throw new Error("ASTRAEA_BOOTSTRAP_OWNER_USERNAME must be set");
	const credentials = basicCredentialsFromEnvironment(env);
	const matches = credentials.filter(
		(credential) => credential.username === username,
	);
	if (matches.length !== 1)
		throw new Error(
			"ASTRAEA_BOOTSTRAP_OWNER_USERNAME must match exactly one configured credential",
		);
	const ownerCredential = matches[0]!;
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		for (const credential of credentials) {
			const conflictingIdentity = await client.query<{ blocked: boolean }>(
				"SELECT EXISTS (SELECT 1 FROM actor_identities WHERE provider_namespace = 'basic:v1' AND canonical_subject = $1 AND (actor_id <> $2 OR organization_id <> $3)) OR EXISTS (SELECT 1 FROM actor_identity_backfill_quarantine WHERE source_table = 'organization_memberships' AND reason IN ('canonical_subject_collision', 'cross_organization_subject') AND CASE WHEN btrim(legacy_subject) <> '' AND normalize(legacy_subject, NFKC) ~ '^[ -~]+$' THEN lower(btrim(normalize(legacy_subject, NFKC))) = $1 ELSE false END) AS blocked",
				[
					credential.canonicalSubject,
					credential.actorId,
					credential.organizationId,
				],
			);
			if (conflictingIdentity.rows[0]?.blocked)
				throw new Error("Bootstrap Basic Auth identity cannot be authorized");
			await client.query(
				"INSERT INTO actors (id) VALUES ($1) ON CONFLICT DO NOTHING",
				[credential.actorId],
			);
			const identity = await client.query(
				"INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'basic:v1', $3) ON CONFLICT (provider_namespace, canonical_subject) DO UPDATE SET actor_id = EXCLUDED.actor_id WHERE actor_identities.actor_id = EXCLUDED.actor_id AND actor_identities.organization_id = EXCLUDED.organization_id RETURNING actor_id",
				[
					credential.actorId,
					credential.organizationId,
					credential.canonicalSubject,
				],
			);
			if (!identity.rows[0])
				throw new Error(
					"Bootstrap Basic Auth identity is already linked to another actor",
				);
		}
		const credential = ownerCredential;
		const organization = await client.query(
			"SELECT id FROM organizations WHERE id = $1",
			[credential.organizationId],
		);
		if (!organization.rows[0])
			throw new Error("Bootstrap organization does not exist");
		await client.query(
			"SELECT actor_subject FROM organization_memberships WHERE organization_id = $1 AND actor_subject = $2 FOR UPDATE",
			[credential.organizationId, credential.username],
		);
		await client.query(
			"SELECT pm.actor_subject FROM project_memberships pm JOIN projects p ON p.id = pm.project_id WHERE p.organization_id = $1 AND pm.actor_subject = $2 ORDER BY p.id, pm.actor_subject FOR UPDATE OF pm",
			[credential.organizationId, credential.username],
		);
		const projects = await client.query<{ id: string }>(
			"SELECT id FROM projects WHERE organization_id = $1 ORDER BY id FOR UPDATE",
			[credential.organizationId],
		);
		await client.query(
			"SELECT lock_project_audit_provenance(id::uuid) FROM unnest($1::uuid[]) AS projects(id) ORDER BY id",
			[projects.rows.map((project) => project.id)],
		);
		await client.query(
			"SELECT id FROM organizations WHERE id = $1 FOR UPDATE",
			[credential.organizationId],
		);
		const owner = await client.query(
			"WITH unfrozen AS (SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = $1 AND status = 'deleting')) INSERT INTO organization_memberships (organization_id, actor_subject, role) SELECT $1, $2, 'owner' FROM unfrozen ON CONFLICT (organization_id, actor_subject) DO UPDATE SET role = 'owner', updated_at = now() WHERE organization_memberships.role <> 'owner' RETURNING 1",
			[credential.organizationId, credential.username],
		);
		const durableOwner = await client.query(
			"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, 'admin') ON CONFLICT (organization_id, actor_id) DO UPDATE SET role = 'admin', updated_at = now() WHERE organization_actor_roles.role <> 'admin' RETURNING 1",
			[credential.organizationId, credential.actorId],
		);
		await client.query(
			"WITH unfrozen AS (SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = $1 AND status = 'deleting')), memberships AS (INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) SELECT id, $1, $2, 'manager' FROM projects CROSS JOIN unfrozen WHERE organization_id = $1 AND status <> 'deleting' ON CONFLICT (project_id, actor_subject) DO UPDATE SET role = 'manager', updated_at = now() WHERE project_memberships.role <> 'manager' RETURNING project_id) INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) SELECT $1, project_id, $2, 'bootstrap_manager_added' FROM memberships ORDER BY project_id RETURNING project_id",
			[credential.organizationId, credential.username],
		);
		if (owner.rowCount)
			await client.query(
				"INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) SELECT $1, id, $2, 'bootstrap_owner_added' FROM projects WHERE organization_id = $1 ORDER BY (slug = 'default') DESC, created_at, id LIMIT 1",
				[credential.organizationId, credential.username],
			);
		if (durableOwner.rowCount)
			await client.query(
				"SELECT audit_admin_access_event($1, NULL, $2, $2, 'bootstrap_owner_granted')",
				[credential.organizationId, credential.actorId],
			);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
		await pool.end();
	}
}

if (import.meta.main) await bootstrapAuthorization();
