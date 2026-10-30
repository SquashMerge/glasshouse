import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { bootstrapAuthorization } from "../../src/db/bootstrap-authorization";
import {
	LocalCredentialError,
	LocalCredentialStore,
	normalizeLocalUsername,
	provisionLocalBootstrap,
} from "../../src/db/local-credentials";
import { migrate } from "../../src/db/migrate";
import * as postgres from "../../src/db/postgres";
import {
	localBootstrapOrganization,
	provisionLocalBootstrapFromEnvironment,
} from "../../src/db/provision-local-bootstrap";
import {
	hashLocalPassword,
	LOCAL_PASSWORD_POLICY,
	verifyLocalPassword,
} from "../../src/lib/local-passwords";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";
import {
	handleRecoverAdmin,
	recoverAdmin,
} from "../../src/routes/admin-access";

const databaseUrl = process.env.DATABASE_URL;
const root = resolve(import.meta.dir, "../../../..");
const databases: string[] = [];
const pools: Pool[] = [];
let adminPool: Pool;
let pool: Pool;
let credentialDatabaseUrl: string;
const token = () => randomBytes(32).toString("base64url");
const password = () => randomBytes(32).toString("base64url");

async function createDatabase(): Promise<{ pool: Pool; url: string }> {
	const name = `local_auth_${randomUUID().replaceAll("-", "")}`;
	await adminPool.query(`CREATE DATABASE ${name}`);
	databases.push(name);
	const url = new URL(databaseUrl!);
	url.pathname = `/${name}`;
	const result = new Pool({ connectionString: url.toString(), max: 10 });
	pools.push(result);
	return { pool: result, url: url.toString() };
}
const script = async (name: string) =>
	readFile(resolve(root, "infra/scripts", name), "utf8");
async function organization(): Promise<string> {
	const id = randomUUID();
	await pool.query(
		`WITH organization AS (INSERT INTO organizations (id, name, slug, default_project_id) VALUES ($1::uuid, 'Local account tests', $1::text, $2) RETURNING id) INSERT INTO projects (id, organization_id, name, slug) SELECT $2, id, 'Default', 'default' FROM organization`,
		[id, randomUUID()],
	);
	return id;
}
async function setup() {
	const id = await organization();
	const secret = token();
	const store = new LocalCredentialStore(pool, id);
	await provisionLocalBootstrap(pool, id, secret);
	return { id, secret, store };
}
async function admin() {
	const fixture = await setup();
	const principal = await fixture.store.bootstrap({
		username: "Admin",
		password: password(),
		token: fixture.secret,
	});
	return { ...fixture, principal };
}
async function state(id: string, database = pool) {
	// No secret material or hash snapshots: only safe identifiers and auth state.
	const result = await database.query(
		`SELECT
		(SELECT count(*)::int FROM actors) AS actors,
		(SELECT count(*)::int FROM actor_identities WHERE organization_id = $1) AS identities,
		(SELECT count(*)::int FROM local_credentials WHERE organization_id = $1) AS credentials,
		(SELECT jsonb_agg(jsonb_build_array(actor_id, enabled, password_hash IS NOT NULL, password_version, updated_at) ORDER BY actor_id) FROM local_credentials WHERE organization_id = $1) AS credential_state,
		(SELECT count(*)::int FROM admin_access_audit_events WHERE organization_id = $1) AS audits,
		(SELECT count(*)::int FROM project_actor_grants WHERE organization_id = $1) AS grants,
		(SELECT count(*)::int FROM organization_memberships WHERE organization_id = $1) AS memberships,
		(SELECT jsonb_agg(jsonb_build_array(id, consumed_at, revoked_at) ORDER BY id) FROM local_account_enrollments WHERE organization_id = $1) AS enrollments,
		(SELECT jsonb_agg(jsonb_build_array(actor_id, role) ORDER BY actor_id) FROM organization_actor_roles WHERE organization_id = $1) AS roles,
		(SELECT jsonb_build_array(closed_at, provisioned_at, expires_at, token_digest IS NOT NULL) FROM local_bootstrap_controls WHERE organization_id = $1) AS setup`,
		[id],
	);
	return result.rows[0];
}
async function rejectedWithoutChanges(
	id: string,
	operation: () => Promise<unknown>,
) {
	const before = await state(id);
	await expect(operation()).rejects.toBeInstanceOf(LocalCredentialError);
	expect(await state(id)).toEqual(before);
}
async function constraintCode(
	operation: () => Promise<unknown>,
): Promise<string | undefined> {
	try {
		await operation();
		return undefined;
	} catch (cause) {
		return (cause as { code: string }).code;
	}
}

async function recover(
	id: string,
	callerActorId?: string,
	database = pool,
): Promise<Response> {
	const username = `recovery-${id}`;
	const owner = await database.query<{ actor_id: string }>(
		"SELECT durable_actor_id('basic:v1', $1) AS actor_id",
		[username],
	);
	const actorId = owner.rows[0]!.actor_id;
	await database.query(
		"INSERT INTO actors (id) VALUES ($1) ON CONFLICT DO NOTHING",
		[actorId],
	);
	await database.query(
		"INSERT INTO actor_identities (organization_id, actor_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'basic:v1', $3) ON CONFLICT DO NOTHING",
		[id, actorId, username],
	);
	const previous = {
		credentials: process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS,
		owner: process.env.GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME,
	};
	const poolProvider = spyOn(postgres, "pgPool").mockReturnValue(database);
	try {
		process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = JSON.stringify([
			{ username, password: password(), organization_id: id },
		]);
		process.env.GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME = username;
		const api = new OpenAPIHono();
		api.use("*", async (c, next) => {
			c.set(TRUSTED_TENANT_CONTEXT_KEY, {
				actor: username,
				actorId: callerActorId ?? actorId,
				organizationId: id,
			});
			await next();
		});
		api.openapi(recoverAdmin, handleRecoverAdmin);
		return await api.request("/v1/admin/recovery", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ confirmation: "RESTORE ADMIN" }),
		});
	} finally {
		poolProvider.mockRestore();
		for (const [key, value] of [
			["GLASSHOUSE_BASIC_AUTH_CREDENTIALS", previous.credentials],
			["GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME", previous.owner],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function assertFinalAdminProtected(id: string, actorId: string) {
	const before = await state(id);
	for (const sql of [
		"UPDATE organization_actor_roles SET role = 'user' WHERE organization_id = $1 AND actor_id = $2",
		"DELETE FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2",
	]) {
		await expect(pool.query(sql, [id, actorId])).rejects.toThrow(
			"cannot remove or demote the final organization Admin",
		);
		expect(await state(id)).toEqual(before);
	}
}

async function basicAdmin(database: Pool, id: string) {
	const actorId = randomUUID();
	await database.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
	await database.query(
		"INSERT INTO actor_identities (organization_id, actor_id, provider_namespace, canonical_subject) VALUES ($1, $2::uuid, 'basic:v1', $2::uuid::text)",
		[id, actorId],
	);
	await database.query(
		"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, 'admin')",
		[id, actorId],
	);
	return { organizationId: id, actorId };
}

const unlinkBasicAdmin = (database: Pool, id: string, actorId: string) =>
	database.query(
		"DELETE FROM actor_identities WHERE organization_id = $1 AND actor_id = $2 AND provider_namespace = 'basic:v1'",
		[id, actorId],
	);

beforeAll(async () => {
	if (!databaseUrl)
		throw new Error(
			"DATABASE_URL is required for real PostgreSQL credential tests",
		);
	adminPool = new Pool({ connectionString: databaseUrl });
	const fresh = await createDatabase();
	pool = fresh.pool;
	credentialDatabaseUrl = fresh.url;
	await migrate({ DATABASE_URL: fresh.url });
	await pool.query(await script("test-db-migrations-0098.assert.sql"));
	await pool.query(await script("test-db-migrations-0099.assert.sql"));
	await pool.query(await script("test-db-migrations-0100.assert.sql"));
}, 60000);
afterAll(async () => {
	for (const pool of pools) await pool.end();
	for (const name of databases)
		await adminPool.query(`DROP DATABASE ${name} WITH (FORCE)`);
	await adminPool?.end();
});

test("0097 populated upgrade preserves all Basic identity, membership, grant and audit rows; runner is repeatable", async () => {
	const upgrade = await createDatabase();
	const directory = resolve(root, "infra/db/migrations");
	const priorMigrationCount = (await readdir(directory)).filter(
		(name) => name.endsWith(".sql") && Number(name.slice(0, 4)) < 98,
	).length;
	await runner({
		databaseUrl: upgrade.url,
		dir: resolve(root, "infra/db/migrations"),
		direction: "up",
		migrationsTable: "pgmigrations",
		migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
		count: priorMigrationCount,
		singleTransaction: true,
		log: () => {},
	});
	expect(
		(
			await upgrade.pool.query(
				"SELECT to_regclass('local_credentials') IS NULL AS before_migration, EXISTS (SELECT 1 FROM pgmigrations WHERE name = '0097_reconcile_evaluation_run_recovery_bounds') AS at_0097",
			)
		).rows[0],
	).toEqual({ before_migration: true, at_0097: true });
	await upgrade.pool.query(await script("test-db-migrations-0098.fixture.sql"));
	await migrate({ DATABASE_URL: upgrade.url });
	await upgrade.pool.query(await script("test-db-migrations-0098.assert.sql"));
	await upgrade.pool.query(
		await script("test-db-migrations-0098-upgrade.assert.sql"),
	);
	await migrate({ DATABASE_URL: upgrade.url });
	await bootstrapAuthorization({
		GLASSHOUSE_AUTH_BOOTSTRAP_MODE: "local",
		DATABASE_URL: upgrade.url,
		UI_USERNAME: "local-upgrade-owner",
		UI_PASSWORD: password(),
		GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: "local-upgrade-owner",
	});
	expect(
		(
			await upgrade.pool.query(
				"SELECT count(*)::int AS count FROM local_credentials",
			)
		).rows[0]?.count,
	).toBe(0);
}, 60000);

test("fresh local mode does not auto-grant Basic Admin; legacy Basic mode still closes setup", async () => {
	const fresh = await createDatabase();
	await migrate({ DATABASE_URL: fresh.url });
	const configuration = {
		DATABASE_URL: fresh.url,
		UI_USERNAME: "compat-owner",
		UI_PASSWORD: password(),
		GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: "compat-owner",
	};
	await bootstrapAuthorization({
		...configuration,
		GLASSHOUSE_AUTH_BOOTSTRAP_MODE: "local",
	});
	expect(
		(
			await fresh.pool.query(
				"SELECT count(*)::int AS count FROM organization_actor_roles",
			)
		).rows[0]?.count,
	).toBe(0);
	expect(
		(
			await fresh.pool.query(
				"SELECT count(*)::int AS count FROM actor_identities WHERE provider_namespace = 'basic:v1'",
			)
		).rows[0]?.count,
	).toBe(1);
	expect(
		(
			await fresh.pool.query(
				"SELECT count(*)::int AS count FROM organization_memberships",
			)
		).rows[0]?.count,
	).toBe(0);
	await bootstrapAuthorization(configuration);
	expect(
		(
			await fresh.pool.query(
				"SELECT closed_at IS NOT NULL AS closed FROM local_bootstrap_controls WHERE organization_id = $1",
				[localBootstrapOrganization({})],
			)
		).rows[0]?.closed,
	).toBe(true);
}, 60000);

test("username exact ASCII policy and server-selected organization configuration", () => {
	for (const value of ["AbC", "A.b_C-9", "Z".repeat(64), "123"])
		expect(normalizeLocalUsername(value)).toBe(value.toLowerCase());
	for (const value of [
		"ab",
		"a".repeat(65),
		".abc",
		"_abc",
		"-abc",
		" abc",
		"abc ",
		"a/b",
		"a@b",
		"ébc",
		"Ａbc",
		"ab\n",
		"abc\n",
	])
		expect(() => normalizeLocalUsername(value)).toThrow(LocalCredentialError);
	expect(localBootstrapOrganization({})).toBe(
		"00000000-0000-4000-8000-000000000001",
	);
	expect(() =>
		localBootstrapOrganization({ GLASSHOUSE_DEFAULT_ORGANIZATION_ID: "bad" }),
	).toThrow();
});

for (const revoked of [false, true]) {
	test(`${revoked ? "revoked" : "unredeemed"} pending Admin cannot satisfy the final-Admin guard or block operator recovery`, async () => {
		const fixture = await admin();
		const pending = await fixture.store.provision(fixture.principal, {
			username: "Pending.Admin",
			role: "admin",
			email: "admin@example.invalid",
		});
		if (revoked)
			await fixture.store.revokeEnrollment(
				fixture.principal,
				pending.enrollmentId,
			);
		expect(await fixture.store.verify("pending.admin", password())).toBeNull();
		await assertFinalAdminProtected(fixture.id, fixture.principal.actorId);
		await pool.query(
			"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
			[fixture.principal.actorId],
		);
		const before = await state(fixture.id);
		expect((await recover(fixture.id, pending.actorId)).status).toBe(403);
		const response = await recover(fixture.id);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			username: `recovery-${fixture.id}`,
			organization_role: "admin",
		});
		const after = await state(fixture.id);
		expect(after.credential_state).toEqual(before.credential_state);
		expect(after.enrollments).toEqual(before.enrollments);
		expect(after.setup).toEqual(before.setup);
		for (const role of before.roles) expect(after.roles).toContainEqual(role);
	});
}

test("successful Admin enrollment permits demotion/removal while blocking break-glass recovery", async () => {
	for (const remove of [false, true]) {
		const fixture = await admin();
		const account = await fixture.store.provision(fixture.principal, {
			username: "Enrolled.Admin",
			role: "admin",
		});
		await assertFinalAdminProtected(fixture.id, fixture.principal.actorId);
		const secret = password();
		await fixture.store.enroll(account.token, secret);
		expect(await fixture.store.verify("enrolled.admin", secret)).toEqual({
			organizationId: fixture.id,
			actorId: account.actorId,
		});
		await pool.query(
			remove
				? "DELETE FROM organization_actor_roles WHERE organization_id = $1 AND actor_id = $2"
				: "UPDATE organization_actor_roles SET role = 'user' WHERE organization_id = $1 AND actor_id = $2",
			[fixture.id, fixture.principal.actorId],
		);
		const response = await recover(fixture.id);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			message: "Organization already has an active Admin",
		});
		await assertFinalAdminProtected(fixture.id, account.actorId);
	}
});

test("disabled enrolled Admin does not satisfy the final-Admin guard or block recovery", async () => {
	const fixture = await admin();
	const account = await fixture.store.provision(fixture.principal, {
		username: "Disabled.Admin",
		role: "admin",
	});
	const secret = password();
	await fixture.store.enroll(account.token, secret);
	await pool.query(
		"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
		[account.actorId],
	);
	await assertFinalAdminProtected(fixture.id, fixture.principal.actorId);
	expect(await fixture.store.verify("disabled.admin", secret)).toBeNull();
	await pool.query(
		"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
		[fixture.principal.actorId],
	);
	expect((await recover(fixture.id)).status).toBe(200);
	expect((await state(fixture.id)).roles).toContainEqual([
		account.actorId,
		"admin",
	]);
});

for (const status of ["pending", "revoked", "expired", "disabled"] as const) {
	test(`${status} local Admin cannot replace an unlinked Basic Admin identity`, async () => {
		const id = await organization();
		const principal = await basicAdmin(pool, id);
		const store = new LocalCredentialStore(pool, id);
		const account = await store.provision(principal, {
			username: "Replacement.Admin",
			role: "admin",
			email: "admin@example.invalid",
		});
		if (status === "revoked" || status === "expired")
			await store.revokeEnrollment(principal, account.enrollmentId);
		if (status === "expired") {
			const expiredToken = token();
			await pool.query(
				"INSERT INTO local_account_enrollments (organization_id, actor_id, provisioned_by, kind, token_digest, created_at, expires_at) VALUES ($1, $2, $3, 'first_use', $4, now() - interval '8 days', now() - interval '1 day')",
				[
					id,
					account.actorId,
					principal.actorId,
					createHash("sha256").update(expiredToken).digest(),
				],
			);
			await rejectedWithoutChanges(id, () =>
				store.enroll(expiredToken, password()),
			);
		}
		if (status === "disabled") {
			await store.enroll(account.token, password());
			await pool.query(
				"UPDATE local_credentials SET enabled = false WHERE organization_id = $1 AND actor_id = $2",
				[id, account.actorId],
			);
		}
		const before = await state(id);
		await expect(unlinkBasicAdmin(pool, id, principal.actorId)).rejects.toThrow(
			"cannot unlink the final organization Admin identity",
		);
		expect(await state(id)).toEqual(before);
	});
}

test("enrolled usable local Admin permits Basic Admin identity unlink without deleting role/account rows", async () => {
	const id = await organization();
	const principal = await basicAdmin(pool, id);
	const store = new LocalCredentialStore(pool, id);
	const account = await store.provision(principal, {
		username: "Replacement.Admin",
		role: "admin",
	});
	const secret = password();
	await store.enroll(account.token, secret);
	expect(await store.verify("replacement.admin", secret)).toEqual({
		organizationId: id,
		actorId: account.actorId,
	});
	const before = await state(id);
	expect((await unlinkBasicAdmin(pool, id, principal.actorId)).rowCount).toBe(
		1,
	);
	expect(await state(id)).toEqual({
		...before,
		identities: before.identities - 1,
	});
	expect(await store.verify("replacement.admin", secret)).not.toBeNull();
});

test("0099 populated upgrade preserves roles/accounts and fixes Basic Admin identity unlink", async () => {
	const upgrade = await createDatabase();
	const directory = resolve(root, "infra/db/migrations");
	await runner({
		databaseUrl: upgrade.url,
		dir: directory,
		direction: "up",
		migrationsTable: "pgmigrations",
		migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
		count: (await readdir(directory)).filter(
			(name) => name.endsWith(".sql") && Number(name.slice(0, 4)) < 100,
		).length,
		singleTransaction: true,
		log: () => {},
	});
	const id = localBootstrapOrganization({});
	const principal = await basicAdmin(upgrade.pool, id);
	await new LocalCredentialStore(upgrade.pool, id).provision(principal, {
		username: "Upgrade.Pending",
		role: "admin",
	});
	const before = await state(id, upgrade.pool);
	const client = await upgrade.pool.connect();
	try {
		await client.query("BEGIN");
		expect(
			(
				await client.query(
					"DELETE FROM actor_identities WHERE organization_id = $1 AND actor_id = $2 AND provider_namespace = 'basic:v1'",
					[id, principal.actorId],
				)
			).rowCount,
		).toBe(1);
	} finally {
		await client.query("ROLLBACK");
		client.release();
	}
	await migrate({ DATABASE_URL: upgrade.url });
	await migrate({ DATABASE_URL: upgrade.url });
	expect(await state(id, upgrade.pool)).toEqual(before);
	await expect(
		unlinkBasicAdmin(upgrade.pool, id, principal.actorId),
	).rejects.toThrow("cannot unlink the final organization Admin identity");
	expect(await state(id, upgrade.pool)).toEqual(before);
	await upgrade.pool.query(await script("test-db-migrations-0100.assert.sql"));
}, 60000);

test("0098 populated upgrade preserves pending Admin records and replaces the unsafe role guard", async () => {
	const upgrade = await createDatabase();
	const directory = resolve(root, "infra/db/migrations");
	await runner({
		databaseUrl: upgrade.url,
		dir: directory,
		direction: "up",
		migrationsTable: "pgmigrations",
		migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
		count: (await readdir(directory)).filter(
			(name) => name.endsWith(".sql") && Number(name.slice(0, 4)) < 99,
		).length,
		singleTransaction: true,
		log: () => {},
	});
	const id = localBootstrapOrganization({});
	const store = new LocalCredentialStore(upgrade.pool, id);
	const secret = token();
	await provisionLocalBootstrap(upgrade.pool, id, secret);
	const principal = await store.bootstrap({
		username: "Upgrade.Admin",
		password: password(),
		token: secret,
	});
	const pending = await store.provision(principal, {
		username: "Upgrade.Pending",
		role: "admin",
	});
	await store.revokeEnrollment(principal, pending.enrollmentId);
	const snapshot = () =>
		upgrade.pool.query(
			"SELECT (SELECT jsonb_agg(jsonb_build_array(actor_id, enabled, password_hash IS NOT NULL, password_version, updated_at) ORDER BY actor_id) FROM local_credentials) AS credentials, (SELECT jsonb_agg(jsonb_build_array(id, actor_id, consumed_at, revoked_at) ORDER BY id) FROM local_account_enrollments) AS enrollments, (SELECT jsonb_agg(to_jsonb(t) ORDER BY actor_id) FROM organization_actor_roles t) AS roles, (SELECT jsonb_agg(jsonb_build_array(organization_id, closed_at, provisioned_at, expires_at) ORDER BY organization_id) FROM local_bootstrap_controls) AS setup",
		);
	const before = await snapshot();
	await migrate({ DATABASE_URL: upgrade.url });
	await migrate({ DATABASE_URL: upgrade.url });
	expect((await snapshot()).rows).toEqual(before.rows);
	await expect(
		upgrade.pool.query(
			"UPDATE organization_actor_roles SET role = 'user' WHERE organization_id = $1 AND actor_id = $2",
			[id, principal.actorId],
		),
	).rejects.toThrow("cannot remove or demote the final organization Admin");
}, 60000);

test("operator provisioning reads a secret file only in explicit local mode and binds the deployment-selected organization", async () => {
	const id = await organization();
	const secret = token();
	const directory = await mkdtemp(resolve(tmpdir(), "glasshouse-bootstrap-"));
	const file = resolve(directory, "token");
	try {
		await writeFile(file, secret, { mode: 0o600 });
		const configuration = {
			DATABASE_URL: credentialDatabaseUrl,
			GLASSHOUSE_AUTH_BOOTSTRAP_MODE: "local",
			GLASSHOUSE_DEFAULT_ORGANIZATION_ID: id,
			GLASSHOUSE_LOCAL_BOOTSTRAP_TOKEN_FILE: file,
		};
		await expect(
			provisionLocalBootstrapFromEnvironment({
				...configuration,
				GLASSHOUSE_AUTH_BOOTSTRAP_MODE: "basic",
			}),
		).rejects.toThrow("Local bootstrap requires local mode");
		await provisionLocalBootstrapFromEnvironment(configuration);
		await writeFile(file, "invalid", { mode: 0o600 });
		const before = await state(id);
		await expect(
			provisionLocalBootstrapFromEnvironment(configuration),
		).rejects.toThrow("Local bootstrap provisioning rejected");
		expect(await state(id)).toEqual(before);
		await new LocalCredentialStore(pool, id).bootstrap({
			username: "Operator.Admin",
			password: password(),
			token: secret,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("hashes use salted versioned Bun Argon2id, verify only valid passwords and reject unsupported versions", async () => {
	const secret = password();
	const first = await hashLocalPassword(secret);
	const second = await hashLocalPassword(secret);
	expect(first.password_hash === second.password_hash).toBe(false);
	expect(
		first.password_hash.startsWith("$argon2id$v=19$m=65536,t=3,p=1$"),
	).toBe(true);
	expect(await verifyLocalPassword(secret, first)).toEqual({
		verified: true,
		rehash: false,
	});
	expect(await verifyLocalPassword(password(), first)).toEqual({
		verified: false,
		rehash: false,
	});
	expect(
		await verifyLocalPassword(secret, { ...first, password_version: 999 }),
	).toEqual({ verified: false, rehash: false });
});

test("invalid, expired, malformed and cross-organization bootstrap attempts leave authorization unchanged", async () => {
	const { store, id, secret } = await setup();
	const valid = { username: "Admin", password: password(), token: secret };
	await rejectedWithoutChanges(id, () =>
		store.bootstrap({ ...valid, token: token() }),
	);
	await rejectedWithoutChanges(id, () =>
		store.bootstrap({ ...valid, token: "bad" }),
	);
	await rejectedWithoutChanges(id, () =>
		store.bootstrap({ ...valid, username: "bad username" }),
	);
	await rejectedWithoutChanges(id, () =>
		store.bootstrap({ ...valid, password: "" }),
	);
	for (const weak of ["x", "😀".repeat(11), "é".repeat(513)])
		await rejectedWithoutChanges(id, () =>
			store.bootstrap({ ...valid, password: weak }),
		);
	await rejectedWithoutChanges(id, () =>
		store.bootstrap({
			...valid,
			organizationId: "00000000-0000-4000-8000-000000000001",
		}),
	);
	const otherId = await organization();
	await rejectedWithoutChanges(otherId, () =>
		new LocalCredentialStore(pool, otherId).bootstrap(valid),
	);
	await pool.query(
		"UPDATE local_bootstrap_controls SET provisioned_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE organization_id = $1",
		[id],
	);
	await rejectedWithoutChanges(id, () => store.bootstrap(valid));
});

test("unused tokens rotate; bootstrap commits once and replay/second setup/rotation cannot change state", async () => {
	const { id, store, secret } = await setup();
	expect(
		await constraintCode(() =>
			pool.query(
				"UPDATE local_bootstrap_controls SET expires_at = NULL WHERE organization_id = $1",
				[id],
			),
		),
	).toBe("23514");
	expect(
		await constraintCode(() =>
			pool.query(
				"DELETE FROM local_bootstrap_controls WHERE organization_id = $1",
				[id],
			),
		),
	).toBe("55000");
	expect(
		(
			await pool.query(
				"SELECT expires_at = provisioned_at + interval '24 hours' AS bounded FROM local_bootstrap_controls WHERE organization_id = $1",
				[id],
			)
		).rows[0]?.bounded,
	).toBe(true);
	const replacement = token();
	await provisionLocalBootstrap(pool, id, replacement);
	await rejectedWithoutChanges(id, () =>
		store.bootstrap({ username: "Admin", password: password(), token: secret }),
	);
	const result = await store.bootstrap({
		username: "Admin",
		password: password(),
		token: replacement,
	});
	expect(Object.keys(result).sort()).toEqual(["actorId", "organizationId"]);
	for (const username of ["Admin", "Second"])
		await rejectedWithoutChanges(id, () =>
			store.bootstrap({ username, password: password(), token: replacement }),
		);
	await rejectedWithoutChanges(id, () =>
		provisionLocalBootstrap(pool, id, token()),
	);
	expect(
		(
			await pool.query(
				"SELECT token_digest IS NULL AND closed_at IS NOT NULL AS consumed FROM local_bootstrap_controls WHERE organization_id = $1",
				[id],
			)
		).rows[0]?.consumed,
	).toBe(true);
	expect(
		await constraintCode(() =>
			pool.query(
				"UPDATE local_bootstrap_controls SET closed_at = NULL WHERE organization_id = $1",
				[id],
			),
		),
	).toBe("55000");
});

test("two genuinely overlapping setup transactions wait on the PostgreSQL fence; exactly one commits", async () => {
	const { id, secret } = await setup();
	const firstApplication = `bootstrap_first_${id.replaceAll("-", "")}`;
	const secondApplication = `bootstrap_second_${id.replaceAll("-", "")}`;
	const firstPool = new Pool({
		connectionString: credentialDatabaseUrl,
		application_name: firstApplication,
		max: 1,
	});
	const secondPool = new Pool({
		connectionString: credentialDatabaseUrl,
		application_name: secondApplication,
		max: 1,
	});
	pools.push(firstPool, secondPool);
	let attempts: Promise<{ committed: boolean }>[] = [];
	const blocker = await pool.connect();
	try {
		await blocker.query("BEGIN");
		await blocker.query(
			"SELECT organization_id FROM local_bootstrap_controls WHERE organization_id = $1 FOR UPDATE",
			[id],
		);
		attempts = [
			new LocalCredentialStore(firstPool, id).bootstrap({
				username: "First",
				password: password(),
				token: secret,
			}),
			new LocalCredentialStore(secondPool, id).bootstrap({
				username: "Second",
				password: password(),
				token: secret,
			}),
		].map((attempt) =>
			attempt.then(
				() => ({ committed: true }),
				() => ({ committed: false }),
			),
		);
		for (let attempt = 0; attempt < 150; attempt++) {
			const waiting = await pool.query<{
				application_name: string;
				query: string;
			}>(
				"SELECT application_name, query FROM pg_stat_activity WHERE datname = current_database() AND application_name = ANY($1::text[]) AND wait_event_type = 'Lock'",
				[[firstApplication, secondApplication]],
			);
			const waitingNames = new Set(
				waiting.rows.map((row) => row.application_name),
			);
			if (
				waitingNames.has(firstApplication) &&
				waitingNames.has(secondApplication)
			) {
				expect(
					waiting.rows.some((row) =>
						row.query.includes("pg_advisory_xact_lock"),
					),
				).toBe(true);
				expect(
					waiting.rows.some((row) =>
						row.query.includes("local_bootstrap_controls"),
					),
				).toBe(true);
				break;
			}
			if (attempt === 149)
				throw new Error("Expected both setup transactions to wait");
			await Bun.sleep(20);
		}
	} finally {
		await blocker.query("COMMIT");
		blocker.release();
	}
	const outcomes = await Promise.all(attempts);
	expect(outcomes.filter((result) => result.committed).length).toBe(1);
	const after = await state(id);
	expect(after.credentials).toBe(1);
	expect(after.roles.length).toBe(1);
	expect(after.roles[0][1]).toBe("admin");
}, 15000);

test("first-Admin recovery waits for overlapping local bootstrap before deciding whether an Admin exists", async () => {
	const { id, secret } = await setup();
	const bootstrapName = `bootstrap-${id}`;
	const recoveryName = `recovery-${id}`;
	const bootstrapPool = new Pool({
		connectionString: credentialDatabaseUrl,
		application_name: bootstrapName,
		max: 1,
	});
	const recoveryPool = new Pool({
		connectionString: credentialDatabaseUrl,
		application_name: recoveryName,
		max: 1,
	});
	pools.push(bootstrapPool, recoveryPool);
	const store = new LocalCredentialStore(bootstrapPool, id);
	const localPassword = password();
	const barrier = `first_admin_barrier_${id.replaceAll("-", "")}`;
	await pool.query(`CREATE FUNCTION ${barrier}() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[0], 198));
			RETURN NEW;
		END;
	$$`);
	await pool.query(`CREATE TRIGGER ${barrier} BEFORE UPDATE ON local_bootstrap_controls
		FOR EACH ROW WHEN (OLD.organization_id = '${id}'::uuid AND OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL)
		EXECUTE FUNCTION ${barrier}('${id}')`);
	const blocker = await pool.connect();
	const attempts: Promise<unknown>[] = [];
	const waitFor = async (applicationName: string, blockingPid: number) => {
		for (let i = 0; i < 150; i++) {
			const result = await pool.query<{ pid: number; query: string }>(
				`SELECT pid, query FROM pg_stat_activity WHERE datname = current_database()
				AND application_name = $1 AND wait_event_type = 'Lock'
				AND $2::int = ANY(pg_blocking_pids(pid))`,
				[applicationName, blockingPid],
			);
			if (result.rows[0]) return result.rows[0];
			await Bun.sleep(20);
		}
		throw new Error(`Expected PostgreSQL waiter: ${applicationName}`);
	};
	try {
		await blocker.query("BEGIN");
		const controller = await blocker.query<{ pid: number }>(
			"SELECT pg_backend_pid() AS pid, pg_advisory_xact_lock(hashtextextended($1, 198))",
			[id],
		);
		const bootstrapping = store.bootstrap({
			username: "Race.Admin",
			password: localPassword,
			token: secret,
		});
		attempts.push(bootstrapping);
		void bootstrapping.catch(() => {});
		const bootstrapWaiter = await waitFor(
			bootstrapName,
			controller.rows[0]!.pid,
		);
		expect(bootstrapWaiter.query).toContain("UPDATE local_bootstrap_controls");
		const recovering = recover(id, undefined, recoveryPool);
		attempts.push(recovering);
		void recovering.catch(() => {});
		const recoveryWaiter = await waitFor(recoveryName, bootstrapWaiter.pid);
		// On the old path the INSERT proves recovery passed its no-Admin decision;
		// the fixed path waits in the lock phase before making that decision.
		expect(
			recoveryWaiter.query.startsWith("SELECT pg_advisory_xact_lock") ||
				recoveryWaiter.query.startsWith("INSERT INTO organization_actor_roles"),
		).toBe(true);
		await blocker.query("COMMIT");
		const [bootstrapOutcome, recoveryOutcome] = await Promise.allSettled([
			bootstrapping,
			recovering,
		]);
		expect(bootstrapOutcome.status).toBe("fulfilled");
		expect(recoveryOutcome.status).toBe("fulfilled");
		if (bootstrapOutcome.status !== "fulfilled") throw bootstrapOutcome.reason;
		if (recoveryOutcome.status !== "fulfilled") throw recoveryOutcome.reason;
		expect(recoveryOutcome.value.status).toBe(409);
		expect(await recoveryOutcome.value.json()).toMatchObject({
			message: "Organization already has an active Admin",
		});
		expect(await store.verify("race.admin", localPassword)).toEqual(
			bootstrapOutcome.value,
		);
		const admins = await pool.query<{ actor_id: string }>(
			"SELECT actor_id FROM organization_actor_roles WHERE organization_id = $1 AND organization_actor_is_usable_admin(organization_id, actor_id)",
			[id],
		);
		expect(admins.rows).toEqual([{ actor_id: bootstrapOutcome.value.actorId }]);
		const after = await state(id);
		expect(after.credentials).toBe(1);
		expect(after.roles).toEqual([[bootstrapOutcome.value.actorId, "admin"]]);
		expect(after.setup).toEqual([expect.any(String), null, null, false]);
		await rejectedWithoutChanges(id, () =>
			store.bootstrap({
				username: "Replay.Admin",
				password: localPassword,
				token: secret,
			}),
		);
	} finally {
		await blocker.query("ROLLBACK");
		blocker.release();
		await Promise.allSettled(attempts);
		await pool.query(`DROP TRIGGER ${barrier} ON local_bootstrap_controls`);
		await pool.query(`DROP FUNCTION ${barrier}()`);
	}
}, 15000);

test("a duplicate local identity rolls back setup consumption, actor creation and audit; the token remains usable", async () => {
	const fixture = await setup();
	const actorId = randomUUID();
	await pool.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
	await pool.query(
		"INSERT INTO actor_identities (organization_id, actor_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'local:v1', $3)",
		[fixture.id, actorId, `${fixture.id}:reserved`],
	);
	await pool.query(
		"INSERT INTO local_credentials (organization_id, actor_id, username) VALUES ($1, $2, 'reserved')",
		[fixture.id, actorId],
	);
	await rejectedWithoutChanges(fixture.id, () =>
		fixture.store.bootstrap({
			username: "Reserved",
			password: password(),
			token: fixture.secret,
		}),
	);
	await fixture.store.bootstrap({
		username: "Initial.Admin",
		password: password(),
		token: fixture.secret,
	});
});

test("organization-scoped username uniqueness, identity ownership, and disabled verification are enforced", async () => {
	const one = await admin();
	const two = await admin();
	const account = await one.store.provision(one.principal, {
		username: "Same.User",
		role: "user",
	});
	await two.store.provision(two.principal, {
		username: "SAME.USER",
		role: "read_only",
	});
	await rejectedWithoutChanges(one.id, () =>
		one.store.provision(one.principal, { username: "SAME.USER", role: "user" }),
	);
	const secret = password();
	await one.store.enroll(account.token, secret);
	expect(await one.store.verify("SAME.USER", secret)).toEqual({
		organizationId: one.id,
		actorId: account.actorId,
	});
	expect(await two.store.verify("same.user", secret)).toBeNull();
	expect(await one.store.verify("same.user", password())).toBeNull();
	await pool.query(
		"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
		[account.actorId],
	);
	expect(await one.store.verify("same.user", secret)).toBeNull();
	const workerId = (
		await pool.query(
			"SELECT actor_id FROM actor_identities WHERE organization_id = $1 AND provider_namespace = 'internal:evaluation-worker:v1'",
			[one.id],
		)
	).rows[0]?.actor_id;
	expect(
		await constraintCode(() =>
			pool.query(
				"UPDATE local_credentials SET organization_id = $1 WHERE actor_id = $2",
				[two.id, account.actorId],
			),
		),
	).toBe("55000");
	expect(
		await constraintCode(() =>
			pool.query(
				"INSERT INTO local_credentials (organization_id, actor_id, username) VALUES ($1, $2, 'unlinked')",
				[two.id, workerId],
			),
		),
	).toBe("23503");
	expect(
		await constraintCode(() =>
			pool.query(
				"INSERT INTO local_credentials (organization_id, actor_id, username) VALUES ($1, $2, 'UPPERCASE')",
				[one.id, workerId],
			),
		),
	).toBe("23514");
	expect(
		await constraintCode(() =>
			pool.query(
				"INSERT INTO actor_identities (organization_id, actor_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'local:v1', $3)",
				[two.id, account.actorId, `${two.id}:duplicate-link`],
			),
		),
	).toBe("23505");
});

test("successful verification rehashes weaker parameters; wrong passwords do not rehash", async () => {
	const fixture = await admin();
	const account = await fixture.store.provision(fixture.principal, {
		username: "Rehash",
		role: "user",
	});
	const secret = password();
	await fixture.store.enroll(account.token, secret);
	const previous = await Bun.password.hash(secret, {
		algorithm: "argon2id",
		memoryCost: 19456,
		timeCost: 2,
	});
	await pool.query(
		"UPDATE local_credentials SET password_hash = $1 WHERE actor_id = $2",
		[previous, account.actorId],
	);
	expect(await fixture.store.verify("rehash", password())).toBeNull();
	expect(
		(
			await pool.query(
				"SELECT password_hash = $1 AS unchanged FROM local_credentials WHERE actor_id = $2",
				[previous, account.actorId],
			)
		).rows[0]?.unchanged,
	).toBe(true);
	expect(await fixture.store.verify("rehash", secret)).not.toBeNull();
	expect(
		(
			await pool.query(
				"SELECT password_hash LIKE '$argon2id$v=19$m=65536,t=3,p=1$%' AND password_version = $1 AS upgraded FROM local_credentials WHERE actor_id = $2",
				[LOCAL_PASSWORD_POLICY.version, account.actorId],
			)
		).rows[0]?.upgraded,
	).toBe(true);
});

test("credential disablement committed during password verification wins its compare-and-set fence", async () => {
	const fixture = await admin();
	const account = await fixture.store.provision(fixture.principal, {
		username: "Race.Disabled",
		role: "user",
	});
	const secret = password();
	await fixture.store.enroll(account.token, secret);
	const blocker = await pool.connect();
	await blocker.query("BEGIN");
	await blocker.query(
		"SELECT actor_id FROM local_credentials WHERE actor_id = $1 FOR UPDATE",
		[account.actorId],
	);
	const verifying = fixture.store.verify("race.disabled", secret);
	try {
		let waiting = false;
		for (let i = 0; i < 150; i++) {
			const result = await pool.query(
				"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'UPDATE local_credentials SET password_hash%') AS waiting",
			);
			if (result.rows[0]?.waiting) {
				waiting = true;
				break;
			}
			await Bun.sleep(20);
		}
		expect(waiting).toBe(true);
		await blocker.query(
			"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
			[account.actorId],
		);
	} finally {
		await blocker.query("COMMIT");
		blocker.release();
	}
	expect(await verifying).toBeNull();
}, 15000);

test("Admin-created and email invitation enrollment is single-use, revocable, tenant-scoped, seven-day and password-free until redeemed", async () => {
	const fixture = await admin();
	const other = await admin();
	const accounts = await Promise.all([
		fixture.store.provision(fixture.principal, {
			username: "First.Use",
			role: "user",
		}),
		fixture.store.provision(fixture.principal, {
			username: "Invited",
			role: "read_only",
			email: "invite@example.invalid",
		}),
	]);
	for (const weak of ["x", "😀".repeat(11), "é".repeat(513)])
		await rejectedWithoutChanges(fixture.id, () =>
			fixture.store.enroll(accounts[0]!.token, weak),
		);
	const records = await pool.query(
		"SELECT kind, email, expires_at = created_at + interval '7 days' AS bounded, token_digest IS NOT NULL AS digest FROM local_account_enrollments WHERE organization_id = $1 ORDER BY kind",
		[fixture.id],
	);
	expect(records.rows.map((row) => row.kind)).toEqual([
		"email_invitation",
		"first_use",
	]);
	expect(records.rows.every((row) => row.bounded && row.digest)).toBe(true);
	expect(
		(
			await pool.query(
				"SELECT bool_and(password_hash IS NULL) AS unset FROM local_credentials WHERE actor_id = ANY($1::uuid[])",
				[accounts.map((account) => account.actorId)],
			)
		).rows[0]?.unset,
	).toBe(true);
	await rejectedWithoutChanges(other.id, () =>
		other.store.enroll(accounts[0]!.token, password()),
	);
	await rejectedWithoutChanges(fixture.id, () =>
		fixture.store.enroll(token(), password()),
	);
	await rejectedWithoutChanges(fixture.id, () =>
		fixture.store.enroll("malformed", password()),
	);
	await rejectedWithoutChanges(fixture.id, () =>
		fixture.store.revokeEnrollment(other.principal, accounts[0]!.enrollmentId),
	);
	const before = await state(fixture.id);
	await expect(
		fixture.store.provision(
			{ organizationId: fixture.id, actorId: accounts[0]!.actorId },
			{ username: "Forbidden", role: "admin" },
		),
	).rejects.toBeInstanceOf(LocalCredentialError);
	expect(await state(fixture.id)).toEqual(before);
	await fixture.store.enroll(accounts[0]!.token, password());
	await rejectedWithoutChanges(fixture.id, () =>
		fixture.store.enroll(accounts[0]!.token, password()),
	);
	await fixture.store.revokeEnrollment(
		fixture.principal,
		accounts[1]!.enrollmentId,
	);
	await rejectedWithoutChanges(fixture.id, () =>
		fixture.store.enroll(accounts[1]!.token, password()),
	);
	expect(
		await constraintCode(() =>
			pool.query(
				"UPDATE local_account_enrollments SET revoked_at = NULL WHERE id = $1",
				[accounts[1]!.enrollmentId],
			),
		),
	).toBe("55000");
});

test("expired and disabled enrollment fail without setting a password or consuming the invitation", async () => {
	const fixture = await admin();
	const expiredToken = token();
	const expired = await fixture.store.provision(fixture.principal, {
		username: "Expired",
		role: "user",
	});
	// An already expired delivery record is inserted directly, never by moving an immutable expiry.
	const digest = createHash("sha256").update(expiredToken).digest();
	await pool.query(
		"INSERT INTO local_account_enrollments (organization_id, actor_id, provisioned_by, kind, token_digest, created_at, expires_at) VALUES ($1, $2, $3, 'first_use', $4, now() - interval '8 days', now() - interval '1 day')",
		[fixture.id, expired.actorId, fixture.principal.actorId, digest],
	);
	await rejectedWithoutChanges(fixture.id, () =>
		fixture.store.enroll(expiredToken, password()),
	);
	await pool.query(
		"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
		[expired.actorId],
	);
	await rejectedWithoutChanges(fixture.id, () =>
		fixture.store.enroll(expired.token, password()),
	);
	expect(
		(
			await pool.query(
				"SELECT password_hash IS NULL AS unset FROM local_credentials WHERE actor_id = $1",
				[expired.actorId],
			)
		).rows[0]?.unset,
	).toBe(true);
	expect(
		(
			await pool.query(
				"SELECT bool_and(consumed_at IS NULL) AS unused FROM local_account_enrollments WHERE actor_id = $1",
				[expired.actorId],
			)
		).rows[0]?.unused,
	).toBe(true);
});
