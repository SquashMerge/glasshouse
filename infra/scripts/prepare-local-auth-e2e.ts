import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
	LocalCredentialStore,
	provisionLocalBootstrap,
} from "../../apps/api/src/db/local-credentials";
import { pgPool } from "../../apps/api/src/db/postgres";
import {
	DEFAULT_ORGANIZATION_ID,
	durableActorId,
} from "../../apps/api/src/middleware/auth";

if (process.env.CI !== "true" || !process.env.DATABASE_URL)
	throw new Error("This fixture is restricted to isolated hosted CI");
const pool = pgPool();
try {
	const file = process.env.E2E_SETUP_SECRET_FILE;
	if (file) {
		const token = randomBytes(32).toString("base64url");
		if (process.env.GITHUB_ACTIONS === "true")
			process.stdout.write(`::add-mask::${token}\n`);
		await provisionLocalBootstrap(pool, DEFAULT_ORGANIZATION_ID, token);
		await writeFile(file, token, { mode: 0o600, flag: "wx" });
	} else {
		const username = process.env.UI_USERNAME;
		const localUsername = process.env.E2E_LOCAL_USERNAME;
		const password = process.env.E2E_LOCAL_PASSWORD;
		if (!username || !localUsername || !password)
			throw new Error("CI browser fixtures are required");
		const store = new LocalCredentialStore(pool, DEFAULT_ORGANIZATION_ID);
		const account = await store.provision(
			{
				organizationId: DEFAULT_ORGANIZATION_ID,
				actorId: durableActorId(username),
			},
			{ username: localUsername, role: "admin" },
		);
		await store.enroll(account.token, password);
	}
} finally {
	await pool.end();
}
