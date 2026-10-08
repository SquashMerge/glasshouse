import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { DEFAULT_ORGANIZATION_ID } from "../middleware/auth.js";
import { provisionLocalBootstrap } from "./local-credentials.js";

export function localBootstrapOrganization(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const organizationId =
		env.GLASSHOUSE_DEFAULT_ORGANIZATION_ID ?? DEFAULT_ORGANIZATION_ID;
	if (
		organizationId.length !== 36 ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			organizationId,
		)
	)
		throw new Error("Invalid bootstrap organization configuration");
	return organizationId.toLowerCase();
}

export async function provisionLocalBootstrapFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (
		env.GLASSHOUSE_AUTH_BOOTSTRAP_MODE !== "local" ||
		!env.GLASSHOUSE_LOCAL_BOOTSTRAP_TOKEN_FILE ||
		!env.DATABASE_URL
	)
		throw new Error(
			"Local bootstrap requires local mode, DATABASE_URL, and GLASSHOUSE_LOCAL_BOOTSTRAP_TOKEN_FILE",
		);
	const organizationId = localBootstrapOrganization(env);
	const pool = new Pool({ connectionString: env.DATABASE_URL });
	try {
		const token = (
			await readFile(env.GLASSHOUSE_LOCAL_BOOTSTRAP_TOKEN_FILE, "utf8")
		).trim();
		await provisionLocalBootstrap(pool, organizationId, token);
	} catch {
		throw new Error("Local bootstrap provisioning rejected");
	} finally {
		await pool.end();
	}
}

if (import.meta.main) await provisionLocalBootstrapFromEnvironment();
