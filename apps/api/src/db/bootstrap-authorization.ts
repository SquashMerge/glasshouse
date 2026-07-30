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
	const credential = matches[0]!;
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const organization = await client.query(
			"SELECT id FROM organizations WHERE id = $1 FOR UPDATE",
			[credential.organizationId],
		);
		if (!organization.rows[0])
			throw new Error("Bootstrap organization does not exist");
		const project = await client.query<{ id: string }>(
			"SELECT id FROM projects WHERE organization_id = $1 AND slug = 'default' AND status = 'active' FOR UPDATE",
			[credential.organizationId],
		);
		if (project.rows.length !== 1)
			throw new Error("Bootstrap requires exactly one active default project");
		const projectId = project.rows[0]!.id;
		const owner = await client.query(
			"INSERT INTO organization_memberships (organization_id, actor_subject, role) VALUES ($1, $2, 'owner') ON CONFLICT (organization_id, actor_subject) DO UPDATE SET role = 'owner', updated_at = now() WHERE organization_memberships.role <> 'owner' RETURNING 1",
			[credential.organizationId, credential.username],
		);
		const manager = await client.query(
			"INSERT INTO project_memberships (project_id, organization_id, actor_subject, role) VALUES ($1, $2, $3, 'manager') ON CONFLICT (project_id, actor_subject) DO UPDATE SET role = 'manager', updated_at = now() WHERE project_memberships.role <> 'manager' RETURNING 1",
			[projectId, credential.organizationId, credential.username],
		);
		if (owner.rowCount)
			await client.query(
				"INSERT INTO project_authorization_audit_events (organization_id, actor_subject, event_type) VALUES ($1, $2, 'bootstrap_owner_added')",
				[credential.organizationId, credential.username],
			);
		if (manager.rowCount)
			await client.query(
				"INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'bootstrap_manager_added')",
				[credential.organizationId, projectId, credential.username],
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
