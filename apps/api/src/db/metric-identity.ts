import type { PoolClient } from "pg";

export async function metricIdentityKey(
	client: PoolClient,
	organizationId: string,
	projectId: string,
): Promise<Buffer> {
	const result = await client.query<{ secret_key: Buffer }>(
		"SELECT secret_key FROM project_metric_identity_keys WHERE organization_id = $1 AND project_id = $2",
		[organizationId, projectId],
	);
	const key = result.rows[0]?.secret_key;
	if (!Buffer.isBuffer(key) || key.length !== 32)
		throw new Error("Metric identity key unavailable");
	return key;
}
