import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { runner } from "node-pg-migrate";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
	LocalCredentialStore,
	provisionLocalBootstrap,
} from "../../src/db/local-credentials";
import {
	LocalSessionStore,
	csrfForSession,
	sessionDigest,
} from "../../src/db/local-sessions";
import { migrate } from "../../src/db/migrate";
import {
	createEvaluation,
	publishEvaluationDraft,
} from "../../src/db/evaluations";
import { admitEvaluationRun } from "../../src/db/evaluation-runs";
import {
	claimOptimizationJob,
	admitOptimizationExecution,
} from "../../src/db/prompt-optimizations";
import {
	listRecoverableExperiments,
	claimExperimentTask,
} from "../../src/db/experiments";
import * as postgres from "../../src/db/postgres";
import { createAuthorizedSseDelivery } from "../../src/lib/authorized-sse";
import {
	DEFAULT_ORGANIZATION_ID,
	PUBLIC_API_ROUTES,
	durableActorId,
} from "../../src/middleware/auth";
import { openapiApp } from "../../src/openapi";
import { lockActiveAuthorizedProject } from "../../src/db/project-authorization";

const secret = () => randomBytes(32).toString("base64url");
const envKeys = [
	"UI_USERNAME",
	"UI_PASSWORD",
	"ASTRAEA_BASIC_AUTH_CREDENTIALS",
	"ASTRAEA_DEFAULT_ORGANIZATION_ID",
	"ASTRAEA_PUBLIC_ORIGIN",
	"ASTRAEA_AUTH_BOOTSTRAP_MODE",
	"NODE_ENV",
] as const;
const originalEnv = Object.fromEntries(
	envKeys.map((key) => [key, process.env[key]]),
);
let pool: Pool;
let fencePool: Pool;
let adminPool: Pool;
let databaseName: string;
let poolSpy: ReturnType<typeof spyOn>;
let createApiApp: typeof import("../../src/index").createApiApp;

beforeAll(async () => {
	if (!process.env.DATABASE_URL)
		throw new Error("Real isolated PostgreSQL is required");
	adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
	databaseName = `sessions_${randomUUID().replaceAll("-", "")}`;
	await adminPool.query(`CREATE DATABASE ${databaseName}`);
	const url = new URL(process.env.DATABASE_URL);
	url.pathname = `/${databaseName}`;
	pool = new Pool({ connectionString: url.toString(), max: 12 });
	fencePool = new Pool({
		connectionString: url.toString(),
		application_name: "auth189-fence",
		max: 10,
	});
	await migrate({ DATABASE_URL: url.toString() });
	await pool.query(
		await readFile(
			resolve(
				import.meta.dir,
				"../../../../infra/scripts/test-db-migrations-0101.assert.sql",
			),
			"utf8",
		),
	);
	poolSpy = spyOn(postgres, "pgPool").mockReturnValue(pool);
	process.env.UI_USERNAME = "session-compat";
	process.env.UI_PASSWORD = secret();
	delete process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS;
	process.env.ASTRAEA_PUBLIC_ORIGIN = "https://astraea.example";
	process.env.ASTRAEA_AUTH_BOOTSTRAP_MODE = "local";
	({ createApiApp } = await import("../../src/index"));
}, 60000);
afterAll(async () => {
	poolSpy?.mockRestore();
	for (const key of envKeys) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
	await fencePool?.end();
	await pool?.end();
	if (databaseName)
		await adminPool.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
	await adminPool?.end();
});

async function fixture() {
	const id = randomUUID();
	const projectId = randomUUID();
	await pool.query(
		"WITH o AS (INSERT INTO organizations(id, name, slug, default_project_id) VALUES ($1::uuid, 'Sessions', $1::text, $2) RETURNING id) INSERT INTO projects(id, organization_id, name, slug) SELECT $2, id, 'Default', 'default' FROM o",
		[id, projectId],
	);
	const credentials = new LocalCredentialStore(pool, id);
	const bootstrapToken = secret();
	const password = secret();
	await provisionLocalBootstrap(pool, id, bootstrapToken);
	const principal = await credentials.bootstrap({
		username: "Local.Admin",
		password,
		token: bootstrapToken,
	});
	process.env.ASTRAEA_DEFAULT_ORGANIZATION_ID = id;
	const sessions = new LocalSessionStore(pool, id);
	const api = createApiApp({
		pgPool: () => pool,
		authenticationPool: () => fencePool,
		handleHealth: async () =>
			new Response("{}", { headers: { "content-type": "application/json" } }),
	});
	const login = async (username = "Local.Admin", inputPassword = password) =>
		api.request("/v1/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://astraea.example",
			},
			body: JSON.stringify({ username, password: inputPassword }),
		});
	const signedIn = async () => {
		const response = await login();
		expect(response.status).toBe(200);
		const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
		const token = cookie.slice("astraea_session=".length);
		return {
			response,
			cookie,
			token,
			headers: {
				cookie,
				"x-astraea-csrf": csrfForSession(token),
				origin: "https://astraea.example",
				"content-type": "application/json",
			},
		};
	};
	return {
		id,
		projectId,
		credentials,
		principal,
		sessions,
		api,
		password,
		login,
		signedIn,
	};
}

async function waitForLock(pattern: string, applicationName?: string) {
	for (let attempt = 0; attempt < 250; attempt++) {
		const result = await pool.query<{ waiting: boolean }>(
			"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $1 AND ($2::text IS NULL OR application_name = $2)) AS waiting",
			[pattern, applicationName ?? null],
		);
		if (result.rows[0]?.waiting) return;
		await Bun.sleep(20);
	}
	throw new Error("Expected PostgreSQL interleaving was not observed");
}

test("local login issues only a production HttpOnly cookie with bounded hashed server state and a separate CSRF value", async () => {
	const f = await fixture();
	process.env.NODE_ENV = "production";
	const signed = await f.signedIn();
	expect(await signed.response.json()).toEqual({ ok: true });
	const attributes = signed.response.headers.get("set-cookie")!;
	for (const attribute of [
		"HttpOnly",
		"Secure",
		"SameSite=Strict",
		"Path=/v1",
		"Max-Age=28800",
	])
		expect(attributes.includes(attribute)).toBe(true);
	expect(attributes.includes("Domain=")).toBe(false);
	const record = await pool.query(
		"SELECT token_digest = $1 AS one_way, expires_at = created_at + interval '8 hours' AS bounded, revoked_at IS NULL AS active FROM local_sessions WHERE actor_id = $2",
		[sessionDigest(signed.token), f.principal.actorId],
	);
	expect(record.rows).toEqual([{ one_way: true, bounded: true, active: true }]);
	const current = await f.api.request("/v1/auth/session", {
		headers: { cookie: signed.cookie },
	});
	expect(current.status).toBe(200);
	const body = await current.json();
	expect(body).toMatchObject({
		actor_id: f.principal.actorId,
		organization_id: f.id,
		authentication: "local_session",
		csrf_token: csrfForSession(signed.token),
	});
	expect(JSON.stringify(body).includes(signed.token)).toBe(false);
	expect(current.headers.get("cache-control")).toBe("no-store");
	expect(await f.sessions.authenticate(body.csrf_token)).toBeNull();
	delete process.env.NODE_ENV;
});

test("disabled local accounts lose SQL-level project authorization", async () => {
	const f = await fixture();
	await pool.query(
		"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
		[f.principal.actorId],
	);
	const authorization = await pool.query<{ allowed: boolean }>(
		"SELECT authorization_allows_project($1, $2, $3, 'product_read') AS allowed",
		[f.id, f.projectId, f.principal.actorId],
	);
	expect(authorization.rows[0]?.allowed).toBe(false);
});

test("wrong-user/password, disabled, malformed and locked-out logins have the same safe failure and bounded limiter rows", async () => {
	const f = await fixture();
	const expected = { code: "UNAUTHORIZED", message: "Authentication required" };
	for (const [name, password] of [
		["unknown", f.password],
		["Local.Admin", secret()],
		["invalid username", f.password],
	]) {
		const response = await f.login(name, password);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual(expected);
		expect(response.headers.get("set-cookie")).toBeNull();
	}
	for (let attempt = 0; attempt < 6; attempt++)
		expect((await f.login("Local.Admin", secret())).status).toBe(401);
	expect((await f.login()).status).toBe(401);
	await pool.query(
		"UPDATE local_login_limits SET window_started_at = clock_timestamp() - interval '16 minutes' WHERE organization_id = $1",
		[f.id],
	);
	expect((await f.login()).status).toBe(200);
	await pool.query(
		"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
		[f.principal.actorId],
	);
	expect(await (await f.login()).json()).toEqual(expected);
	const malicious = await f.api.request("/v1/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			username: "Local.Admin",
			password: f.password,
			organization_id: DEFAULT_ORGANIZATION_ID,
			role: "admin",
		}),
	});
	expect(malicious.status).toBe(401);
	expect(await malicious.json()).toEqual(expected);
	const limits = await pool.query(
		"SELECT count(*)::int AS rows, max(attempts) <= 120 AS bounded FROM local_login_limits WHERE organization_id = $1",
		[f.id],
	);
	expect(limits.rows[0].rows <= 257).toBe(true);
	expect(limits.rows[0].bounded).toBe(true);
});

test("malformed, duplicate, expired, cross-organization and revoked session cookies never fall back to valid Basic", async () => {
	const f = await fixture();
	const actorId = durableActorId("session-compat");
	await pool.query("INSERT INTO actors(id) VALUES ($1)", [actorId]);
	await pool.query(
		"INSERT INTO actor_identities(organization_id, actor_id, provider_namespace, canonical_subject) VALUES ($1, $2, 'basic:v1', 'session-compat')",
		[f.id, actorId],
	);
	const authorization = `Basic ${Buffer.from(`session-compat:${process.env.UI_PASSWORD}`).toString("base64")}`;
	expect(
		(await f.api.request("/v1/auth/session", { headers: { authorization } }))
			.status,
	).toBe(200);
	const signed = await f.signedIn();
	const expired = secret();
	await pool.query(
		"INSERT INTO local_sessions(organization_id, actor_id, token_digest, auth_version, created_at, expires_at) SELECT organization_id, actor_id, $2, auth_version, now() - interval '9 hours', now() - interval '1 hour' FROM local_credentials WHERE actor_id = $1",
		[f.principal.actorId, sessionDigest(expired)],
	);
	for (const cookie of [
		"astraea_session=bad",
		"astraea_session=%ZZ",
		"astraea_session",
		`${signed.cookie}; ${signed.cookie}`,
		`astraea_session=${expired}`,
	])
		expect(
			(
				await f.api.request("/v1/auth/session", {
					headers: { cookie, authorization },
				})
			).status,
		).toBe(401);
	expect(
		await new LocalSessionStore(pool, DEFAULT_ORGANIZATION_ID).authenticate(
			signed.token,
		),
	).toBeNull();
	await f.sessions.logout((await f.sessions.authenticate(signed.token))!);
	expect(
		(
			await f.api.request("/v1/auth/session", {
				headers: { cookie: signed.cookie, authorization },
			})
		).status,
	).toBe(401);
});

test("CSRF rejects cookie mutations and mixed Basic headers before writes; login rejects foreign origins", async () => {
	const f = await fixture();
	const signed = await f.signedIn();
	const count = async () =>
		(
			await pool.query(
				"SELECT count(*)::int AS count FROM projects WHERE organization_id = $1",
				[f.id],
			)
		).rows[0].count;
	const before = await count();
	for (const extra of [
		{},
		{ "x-astraea-csrf": "bad" },
		{
			"x-astraea-csrf": csrfForSession(signed.token),
			origin: "https://evil.example",
		},
		{
			"x-astraea-csrf": csrfForSession(signed.token),
			"sec-fetch-site": "same-site",
		},
	]) {
		const response = await f.api.request("/v1/projects", {
			method: "POST",
			headers: {
				cookie: signed.cookie,
				authorization: "Basic ignored",
				"content-type": "application/json",
				...extra,
			},
			body: JSON.stringify({ name: "Forbidden", slug: "forbidden" }),
		});
		expect(response.status).toBe(403);
	}
	expect(await count()).toBe(before);
	const foreignLogin = await f.api.request("/v1/auth/login", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: "https://evil.example",
		},
		body: JSON.stringify({ username: "Local.Admin", password: f.password }),
	});
	expect(foreignLogin.status).toBe(403);
});

test("local actors boot the workspace, create projects and use current durable grants without legacy memberships", async () => {
	const f = await fixture();
	const signed = await f.signedIn();
	for (const path of ["/v1/me", "/v1/projects"])
		expect(
			(await f.api.request(path, { headers: signed.headers })).status,
		).toBe(200);
	const me = await (
		await f.api.request("/v1/me", { headers: signed.headers })
	).json();
	expect(me).toMatchObject({
		actor_id: f.principal.actorId,
		organization_id: f.id,
		organization_role: "admin",
		can_recover_admin: false,
	});
	expect(me.projects.map((project: { id: string }) => project.id)).toContain(
		f.projectId,
	);
	const created = await f.api.request("/v1/projects", {
		method: "POST",
		headers: signed.headers,
		body: JSON.stringify({ name: "Local project", slug: "local-project" }),
	});
	expect(created.status).toBe(201);
	const createdProject = await created.json();
	const account = await f.credentials.provision(f.principal, {
		username: "Local.Reader",
		role: "read_only",
	});
	const password = secret();
	await f.credentials.enroll(account.token, password);
	const session = (await f.sessions.login("local.reader", password))!;
	const headers = { cookie: `astraea_session=${session.token}` };
	const roleProjects = await (
		await f.api.request("/v1/me", { headers })
	).json();
	expect(
		roleProjects.projects.map((project: { id: string }) => project.id).sort(),
	).toEqual([f.projectId, createdProject.id].sort());
	await pool.query("DELETE FROM organization_actor_roles WHERE actor_id = $1", [
		account.actorId,
	]);
	expect(
		(await (await f.api.request("/v1/me", { headers })).json()).projects,
	).toEqual([]);
	expect(
		(
			await pool.query(
				"SELECT count(*)::int AS count FROM organization_memberships WHERE organization_id = $1",
				[f.id],
			)
		).rows[0].count,
	).toBe(0);
});

test("logout revokes one session; self password change, Admin reset and disable revoke every intended session", async () => {
	const f = await fixture();
	const one = await f.signedIn();
	const two = await f.signedIn();
	const three = await f.signedIn();
	const rejectedChange = await f.api.request("/v1/auth/password", {
		method: "POST",
		headers: two.headers,
		body: JSON.stringify({
			current_password: "incorrect-current-password",
			new_password: secret(),
		}),
	});
	expect(rejectedChange.status).toBe(422);
	expect((await rejectedChange.json()).code).toBe("INVALID_CURRENT_PASSWORD");
	expect(await f.sessions.authenticate(two.token)).not.toBeNull();
	const logout = await f.api.request("/v1/auth/logout", {
		method: "POST",
		headers: one.headers,
	});
	expect(logout.status).toBe(200);
	expect(logout.headers.get("set-cookie")!.includes("Max-Age=0")).toBe(true);
	expect(await f.sessions.authenticate(one.token)).toBeNull();
	expect(await f.sessions.authenticate(two.token)).not.toBeNull();
	expect(await f.sessions.authenticate(three.token)).not.toBeNull();
	const newPassword = secret();
	const changed = await f.api.request("/v1/auth/password", {
		method: "POST",
		headers: two.headers,
		body: JSON.stringify({
			current_password: f.password,
			new_password: newPassword,
		}),
	});
	expect(changed.status).toBe(200);
	expect(await f.sessions.authenticate(two.token)).toBeNull();
	expect(await f.sessions.authenticate(three.token)).toBeNull();
	expect(await f.sessions.login("Local.Admin", f.password)).toBeNull();
	expect(await f.sessions.login("Local.Admin", newPassword)).not.toBeNull();
	const account = await f.credentials.provision(f.principal, {
		username: "Reset.User",
		role: "user",
	});
	const password = secret();
	await f.credentials.enroll(account.token, password);
	const session = (await f.sessions.login("Reset.User", password))!;
	const reset = await f.credentials.initiatePasswordReset(
		f.principal,
		account.actorId,
	);
	expect(await f.sessions.authenticate(session.token)).toBeNull();
	expect(await f.sessions.login("Reset.User", password)).toBeNull();
	await f.credentials.enroll(reset.token, secret());
	await pool.query(
		"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
		[f.principal.actorId],
	);
	expect(
		(
			await pool.query(
				"SELECT count(*)::int AS count FROM local_sessions WHERE actor_id = $1 AND revoked_at IS NULL",
				[f.principal.actorId],
			)
		).rows[0].count,
	).toBe(0);
});

test("every registered protected route, docs/raw handlers and unknown internal routes reject unauthenticated requests", async () => {
	const f = await fixture();
	const document = openapiApp.getOpenAPI31Document({
		openapi: "3.1.0",
		info: { title: "Authentication inventory", version: "test" },
	});
	const exposed: string[] = [];
	for (const [path, item] of Object.entries(document.paths!)) {
		for (const [method, operation] of Object.entries(item!)) {
			if (
				!["get", "post", "put", "patch", "delete", "head", "options"].includes(
					method,
				)
			)
				continue;
			const key = `${method.toUpperCase()} ${path}`;
			if (PUBLIC_API_ROUTES.has(key)) {
				expect((operation as { security: unknown[] }).security).toEqual([]);
				exposed.push(key);
				continue;
			}
			expect((operation as { security: unknown[] }).security.length > 0).toBe(
				true,
			);
			const response = await f.api.request(
				path.replaceAll(/\{[^}]+\}/g, randomUUID()),
				{ method: method.toUpperCase() },
			);
			expect(response.status).toBe(401);
		}
	}
	expect(exposed.sort()).toEqual(
		[...PUBLIC_API_ROUTES]
			.filter((key) => !key.includes("/health") || key === "GET /v1/health")
			.sort(),
	);
	for (const path of [
		"/openapi.json",
		"/reference",
		"/internal/worker",
		"/v1/unknown",
		"/v1/auth/setup/extra",
	])
		expect((await f.api.request(path)).status).toBe(401);
	for (const path of ["/health", "/v1/health"])
		for (const method of ["GET", "HEAD"])
			expect((await f.api.request(path, { method })).status).toBe(200);
	expect((await f.api.request("/v1/auth/setup")).status).toBe(200);
});

for (const mutation of ["disable", "revoke"] as const) {
	test(`${mutation} wins the PostgreSQL request fence: no protected project write or audit occurs`, async () => {
		const f = await fixture();
		const signed = await f.signedIn();
		const session = (await f.sessions.authenticate(signed.token))!;
		const blocker = await pool.connect();
		await blocker.query("BEGIN");
		await blocker.query(
			mutation === "disable"
				? "UPDATE local_credentials SET enabled = false WHERE actor_id = $1"
				: "UPDATE local_sessions SET revoked_at = clock_timestamp() WHERE id = $1",
			[mutation === "disable" ? f.principal.actorId : session.sessionId],
		);
		const request = f.api.request("/v1/projects", {
			method: "POST",
			headers: signed.headers,
			body: JSON.stringify({ name: "Denied race", slug: "denied-race" }),
		});
		try {
			await waitForLock("SELECT %", "auth189-fence");
		} finally {
			await blocker.query("COMMIT");
			blocker.release();
		}
		expect((await request).status).toBe(401);
		expect(
			(
				await pool.query(
					"SELECT count(*)::int AS count FROM projects WHERE organization_id = $1 AND slug = 'denied-race'",
					[f.id],
				)
			).rows[0].count,
		).toBe(0);
		expect(
			(
				await pool.query(
					"SELECT count(*)::int AS count FROM project_authorization_audit_events WHERE organization_id = $1",
					[f.id],
				)
			).rows[0].count,
		).toBe(0);
	}, 15000);
}

test("request wins its fence: disable waits for the admitted protected effect to settle", async () => {
	const f = await fixture();
	let entered!: () => void;
	const enteredPromise = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let providerCalls = 0;
	f.api.post("/v1/projects/test-effect", async (c) => {
		entered();
		await gate;
		providerCalls++;
		await pool.query(
			"INSERT INTO projects(organization_id, name, slug) VALUES ($1, 'Admitted effect', 'admitted-effect')",
			[f.id],
		);
		return c.json({ ok: true });
	});
	const signed = await f.signedIn();
	const request = f.api.request("/v1/projects/test-effect", {
		method: "POST",
		headers: signed.headers,
	});
	await enteredPromise;
	const disabling = pool.query(
		"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
		[f.principal.actorId],
	);
	try {
		await waitForLock("UPDATE local_credentials SET enabled%");
		expect(providerCalls).toBe(0);
	} finally {
		release();
	}
	expect((await request).status).toBe(200);
	await disabling;
	expect(providerCalls).toBe(1);
	expect(
		(
			await f.api.request("/v1/projects/test-effect", {
				method: "POST",
				headers: signed.headers,
			})
		).status,
	).toBe(401);
	expect(providerCalls).toBe(1);
}, 15000);

test("disable committed during Argon2 verification prevents session admission", async () => {
	const f = await fixture();
	const blocker = await pool.connect();
	await blocker.query("BEGIN");
	await blocker.query(
		"SELECT actor_id FROM local_credentials WHERE actor_id = $1 FOR UPDATE",
		[f.principal.actorId],
	);
	const login = f.login();
	try {
		await waitForLock("UPDATE local_credentials SET password_hash%");
		await blocker.query(
			"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
			[f.principal.actorId],
		);
	} finally {
		await blocker.query("COMMIT");
		blocker.release();
	}
	expect((await login).status).toBe(401);
	expect(
		(
			await pool.query(
				"SELECT count(*)::int AS count FROM local_sessions WHERE actor_id = $1",
				[f.principal.actorId],
			)
		).rows[0].count,
	).toBe(0);
}, 15000);

test("SSE revalidates each local session frame and workers recheck local eligibility without a Basic subject", async () => {
	const f = await fixture();
	const signed = await f.signedIn();
	const tenant = (await f.sessions.authenticate(signed.token))!;
	let frames = 0;
	let aborted = false;
	const stream = {
		get aborted() {
			return aborted;
		},
		abort() {
			aborted = true;
		},
		onAbort() {},
		write: async () => {},
		writeSSE: async () => {},
	};
	const delivery = createAuthorizedSseDelivery({
		stream,
		pool: () => pool,
		tenant,
		projectId: f.projectId,
		onClose() {},
	});
	expect(
		await delivery.deliver({
			bytes: 1,
			write: async () => {
				frames++;
			},
		}),
	).toBe(true);
	await f.sessions.logout(tenant);
	expect(
		await delivery.deliver({
			bytes: 1,
			write: async () => {
				frames++;
			},
		}),
	).toBe(false);
	expect(frames).toBe(1);
	expect(aborted).toBe(true);
	const workerFence = async () => {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			return await lockActiveAuthorizedProject(client, f.projectId, {
				organization_id: f.id,
				actor_id: tenant.actorId,
				operation: "execute",
			});
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	};
	expect(await workerFence()).toBe(true);
	await pool.query(
		"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
		[tenant.actorId],
	);
	expect(await workerFence()).toBe(false);
	expect(
		(
			await pool.query(
				"SELECT trusted_actor_subject_matches($1, $2, $3) AS matches",
				[f.id, tenant.actor, tenant.actorId],
			)
		).rows[0].matches,
	).toBe(true);
});

test("auth audits contain only safe fields; session digests cannot be used as bearer cookies", async () => {
	const f = await fixture();
	const signed = await f.signedIn();
	await f.login("unknown", secret());
	const audits = await pool.query(
		"SELECT * FROM local_auth_audit_events WHERE organization_id = $1",
		[f.id],
	);
	expect(audits.rows.length).toBe(2);
	for (const row of audits.rows)
		expect(Object.keys(row).sort()).toEqual([
			"action",
			"actor_id",
			"created_at",
			"id",
			"organization_id",
		]);
	const serialized = JSON.stringify(audits.rows);
	for (const value of [signed.token, f.password, "Local.Admin", "unknown"])
		expect(serialized.includes(value)).toBe(false);
	expect(
		await f.sessions.authenticate(
			createHash("sha256").update(signed.token).digest("base64url"),
		),
	).toBeNull();
});

test("raw OTLP accepts the trusted local principal and denies tenant, CSRF and current-role failures before writer effects", async () => {
	const f = await fixture();
	let writes = 0;
	const api = createApiApp({
		pgPool: () => pool,
		authenticationPool: () => fencePool,
		handleOtlpIngest: async (_request, tenant) => {
			writes++;
			expect(tenant).toMatchObject({
				organizationId: f.id,
				actorId: f.principal.actorId,
				projectId: f.projectId,
			});
			return new Response("{}", {
				headers: { "content-type": "application/json" },
			});
		},
	});
	const signed = await f.signedIn();
	const request = (headers: Record<string, string>) =>
		api.request("/v1/otel/v1/traces", {
			method: "POST",
			headers,
			body: JSON.stringify({ resource_spans: [] }),
		});
	const headers = { ...signed.headers, "x-astraea-project-id": f.projectId };
	expect((await request(headers)).status).toBe(200);
	expect(
		(await request({ ...headers, "x-astraea-project-id": randomUUID() }))
			.status,
	).toBe(404);
	expect(
		(await request({ ...headers, "x-astraea-csrf": "wrong" })).status,
	).toBe(403);
	await pool.query(
		"UPDATE authorization_policy_settings SET strict_enforcement = true, enabled_at = now() WHERE organization_id = $1",
		[f.id],
	);
	const other = await f.credentials.provision(f.principal, {
		username: "Other.Admin",
		role: "admin",
	});
	await f.credentials.enroll(other.token, secret());
	await pool.query(
		"UPDATE organization_actor_roles SET role = 'read_only' WHERE actor_id = $1",
		[f.principal.actorId],
	);
	expect((await request(headers)).status).toBe(404);
	expect(writes).toBe(1);
});

test("setup and invitation transports are operator/single-use guarded and never return secrets", async () => {
	const f = await fixture();
	const invitation = await f.credentials.provision(f.principal, {
		username: "Transport.User",
		role: "user",
	});
	const accept = (token: string) =>
		f.api.request("/v1/auth/invitations/accept", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://astraea.example",
			},
			body: JSON.stringify({ token, password: secret() }),
		});
	expect(await (await accept(invitation.token)).json()).toEqual({ ok: true });
	expect((await accept(invitation.token)).status).toBe(401);
	const setup = await f.api.request("/v1/auth/setup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			username: "Another.Admin",
			password: f.password,
			token: secret(),
		}),
	});
	expect(setup.status).toBe(401);
	expect(await (await f.api.request("/v1/auth/setup")).json()).toEqual({
		available: false,
	});
});

test("session identity/lifetime and audit immutability, tenant scope and storage-managed credential versions fail closed", async () => {
	const f = await fixture();
	const signed = await f.signedIn();
	const tenant = (await f.sessions.authenticate(signed.token))!;
	for (const query of [
		() =>
			pool.query(
				"UPDATE local_sessions SET expires_at = expires_at + interval '1 hour' WHERE id = $1",
				[tenant.sessionId],
			),
		() =>
			pool.query(
				"UPDATE local_sessions SET organization_id = $2 WHERE id = $1",
				[tenant.sessionId, DEFAULT_ORGANIZATION_ID],
			),
		() =>
			pool.query("UPDATE local_sessions SET token_digest = $2 WHERE id = $1", [
				tenant.sessionId,
				sessionDigest(secret()),
			]),
		() =>
			pool.query(
				"UPDATE local_credentials SET auth_version = auth_version + 1 WHERE actor_id = $1",
				[tenant.actorId],
			),
		() =>
			pool.query(
				"UPDATE local_auth_audit_events SET action = 'login_failed' WHERE organization_id = $1",
				[f.id],
			),
		() =>
			pool.query(
				"INSERT INTO local_auth_audit_events(organization_id, actor_id, action) VALUES ($1, $2, 'login_succeeded')",
				[DEFAULT_ORGANIZATION_ID, tenant.actorId],
			),
	])
		await expect(query()).rejects.toBeInstanceOf(Error);
	await f.sessions.logout(tenant);
	await expect(
		pool.query("UPDATE local_sessions SET revoked_at = NULL WHERE id = $1", [
			tenant.sessionId,
		]),
	).rejects.toBeInstanceOf(Error);
	await pool.query(
		"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
		[tenant.actorId],
	);
	await pool.query(
		"UPDATE local_credentials SET enabled = true WHERE actor_id = $1",
		[tenant.actorId],
	);
	expect(await f.sessions.authenticate(signed.token)).toBeNull();
});

test("login storage is bounded across sessions and anonymous identifiers, including the organization-wide budget", async () => {
	const f = await fixture();
	const tokens: string[] = [];
	for (let login = 0; login < 12; login++)
		tokens.push((await f.sessions.login("Local.Admin", f.password))!.token);
	expect(new Set(tokens).size).toBe(12);
	expect(await f.sessions.authenticate(tokens[0]!)).toBeNull();
	expect(
		(
			await pool.query(
				"SELECT count(*)::int AS count FROM local_sessions WHERE actor_id = $1 AND revoked_at IS NULL",
				[f.principal.actorId],
			)
		).rows[0].count,
	).toBe(10);
	await pool.query(
		"UPDATE local_login_limits SET attempts = 0 WHERE organization_id = $1",
		[f.id],
	);
	for (let attempt = 0; attempt < 120; attempt++)
		await f.sessions.reserveAttempt(randomUUID());
	expect(await f.sessions.reserveAttempt(randomUUID())).toBe(false);
	const limits = await pool.query(
		"SELECT count(*)::int AS count FROM local_login_limits WHERE organization_id = $1",
		[f.id],
	);
	expect(limits.rows[0].count <= 257).toBe(true);
}, 15000);

test("populated exact-0100 upgrade preserves local/Basic roles, credentials and audit history and reruns cleanly", async () => {
	const name = `session_upgrade_${randomUUID().replaceAll("-", "")}`;
	await adminPool.query(`CREATE DATABASE ${name}`);
	const url = new URL(process.env.DATABASE_URL!);
	url.pathname = `/${name}`;
	const upgrade = new Pool({ connectionString: url.toString() });
	try {
		const directory = resolve(
			import.meta.dir,
			"../../../../infra/db/migrations",
		);
		await runner({
			databaseUrl: url.toString(),
			dir: directory,
			direction: "up",
			migrationsTable: "pgmigrations",
			migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
			count: (await readdir(directory)).filter(
				(file) => file.endsWith(".sql") && Number(file.slice(0, 4)) < 101,
			).length,
			singleTransaction: true,
			log: () => {},
		});

		expect(
			(
				await upgrade.query(
					"SELECT to_regclass('local_sessions') IS NULL AS before",
				)
			).rows[0].before,
		).toBe(true);
		const credentials = new LocalCredentialStore(
			upgrade,
			DEFAULT_ORGANIZATION_ID,
		);
		const token = secret();
		await provisionLocalBootstrap(upgrade, DEFAULT_ORGANIZATION_ID, token);
		await credentials.bootstrap({
			username: "Upgrade.Admin",
			password: secret(),
			token,
		});
		const snapshot = async () =>
			(
				await upgrade.query(
					"SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY actor_id) FROM organization_actor_roles r) AS roles, (SELECT jsonb_agg(to_jsonb(i) ORDER BY actor_id) FROM actor_identities i) AS identities, (SELECT jsonb_agg(jsonb_build_array(actor_id, enabled, password_hash IS NOT NULL, password_version, updated_at) ORDER BY actor_id) FROM local_credentials) AS credentials, (SELECT count(*)::int FROM admin_access_audit_events) AS audits",
				)
			).rows[0];
		const before = await snapshot();
		await migrate({ DATABASE_URL: url.toString() });
		await migrate({ DATABASE_URL: url.toString() });
		expect(await snapshot()).toEqual(before);
		await upgrade.query(
			await readFile(
				resolve(
					import.meta.dir,
					"../../../../infra/scripts/test-db-migrations-0101.assert.sql",
				),
				"utf8",
			),
		);
	} finally {
		await upgrade.end();
		await adminPool.query(`DROP DATABASE ${name} WITH (FORCE)`);
	}
}, 60000);

test("local actors admit real Evaluation Runs and experiment tasks; disable denies dispatch/recovery without changing tenant provenance", async () => {
	const f = await fixture();
	await pool.query(
		await readFile(
			resolve(
				import.meta.dir,
				"../../../../infra/scripts/test-db-migrations-0102.assert.sql",
			),
			"utf8",
		),
	);
	const datasetId = randomUUID();
	const versionId = randomUUID();
	await pool.query(
		"INSERT INTO datasets(id, project_id, slug, name) VALUES ($1, $2, 'session-evaluation', 'Session evaluation')",
		[datasetId, f.projectId],
	);
	await pool.query(
		"INSERT INTO dataset_versions(id, project_id, dataset_id, version, item_count, content_hash) VALUES ($1, $2, $3, 1, 1, repeat('0', 64))",
		[versionId, f.projectId, datasetId],
	);
	await pool.query(
		"INSERT INTO dataset_version_items(project_id, dataset_version_id, item_key, position, input, expected_output) VALUES ($1, $2, 'example', 0, '{\"question\":true}', '{\"value\":true}')",
		[f.projectId, versionId],
	);
	await pool.query(
		"UPDATE datasets SET latest_published_version = 1 WHERE id = $1",
		[datasetId],
	);
	const authorization = {
		organization_id: f.id,
		actor_id: f.principal.actorId,
		operation: "execute" as const,
	};
	const definition = {
		dataset_version_id: versionId,
		sampling: { strategy: "first_n" as const, sample_size: 1, seed: 0 },
		evaluator: {
			kind: "exact_match" as const,
			version: "v1" as const,
			expected_output_path: "$.value",
			output_path: "$.output",
		},
		target: {
			kind: "configured_llm" as const,
			model: "gpt-4o-mini",
			system_prompt: null,
		},
		execution_defaults: { temperature: 0, max_tokens: null },
		limits: { max_cost_usd: 10, max_duration_seconds: 60 },
		thresholds: { minimum_pass_rate: null },
	};
	await createEvaluation(pool, {
		project_id: f.projectId,
		slug: "session-evaluation",
		name: "Session evaluation",
		definition,
		authorization: { ...authorization, operation: "curation_write" },
	});
	await publishEvaluationDraft(pool, {
		project_id: f.projectId,
		slug: "session-evaluation",
		revision: 1,
		authorization: { ...authorization, operation: "curation_write" },
	});
	const run = await admitEvaluationRun(pool, {
		project_id: f.projectId,
		evaluation_selector: "session-evaluation",
		definition_version: 1,
		idempotency_key: randomUUID(),
		authorization,
	});
	expect(run.requested_by_actor_id).toBe(f.principal.actorId);
	expect(run.organization_id).toBe(f.id);
	expect(
		(await listRecoverableExperiments(pool)).some(
			(experiment) => experiment.id === run.experiment_id,
		),
	).toBe(true);
	await expect(
		admitEvaluationRun(pool, {
			project_id: f.projectId,
			evaluation_selector: "session-evaluation",
			definition_version: 1,
			idempotency_key: randomUUID(),
			authorization: {
				...authorization,
				organization_id: DEFAULT_ORGANIZATION_ID,
			},
		}),
	).rejects.toBeInstanceOf(Error);
	await pool.query(
		"UPDATE local_credentials SET enabled = false WHERE actor_id = $1",
		[f.principal.actorId],
	);
	expect(
		await claimExperimentTask(pool, {
			project_id: f.projectId,
			experiment_id: run.experiment_id,
			lease_token: randomUUID(),
		}),
	).toBeNull();
	expect(
		(await listRecoverableExperiments(pool)).some(
			(experiment) => experiment.id === run.experiment_id,
		),
	).toBe(false);
});

test("local optimization requester lookup admits the durable actor and role revocation cancels its jobs", async () => {
	const f = await fixture();
	const promptId = randomUUID();
	const jobId = randomUUID();
	const workerId = randomUUID();
	await pool.query(
		"INSERT INTO prompts(id, project_id, name, slug) VALUES ($1, $2, 'Local optimization', 'local-optimization')",
		[promptId, f.projectId],
	);
	await pool.query(
		"INSERT INTO prompt_optimization_jobs(id, project_id, prompt_id, prompt_slug, source_version, target_role, source_messages, evaluator, examples, model_config, budget, status, requested_by, dataset, dataset_hash) VALUES ($1, $2, $3, 'local-optimization', 1, 'system', '[]', '{}', '[]', '{}', '{\"max_metric_calls\":5}', 'queued', $4, '{\"version\":1,\"rubric\":\"Test fixture\",\"training_examples\":[],\"validation_examples\":[]}', repeat('0', 64))",
		[jobId, f.projectId, promptId, `actor:${f.principal.actorId}`],
	);
	expect(
		await claimOptimizationJob(pool, { id: jobId, worker_id: workerId }),
	).toBe(true);
	await pool.query(
		"UPDATE prompt_optimization_jobs SET status = 'optimizing' WHERE id = $1",
		[jobId],
	);
	const admission = await admitOptimizationExecution(pool, {
		id: jobId,
		worker_id: workerId,
		timeout_ms: 30000,
	});
	expect(admission?.requester_actor_id).toBe(f.principal.actorId);
	const replacement = await f.credentials.provision(f.principal, {
		username: "Replacement.Admin",
		role: "admin",
	});
	await f.credentials.enroll(replacement.token, secret());
	await pool.query(
		"UPDATE organization_actor_roles SET role = 'user' WHERE actor_id = $1",
		[f.principal.actorId],
	);
	expect(
		(
			await pool.query(
				"SELECT status FROM prompt_optimization_jobs WHERE id = $1",
				[jobId],
			)
		).rows[0].status,
	).toBe("stopped");
	expect(
		await admitOptimizationExecution(pool, {
			id: jobId,
			worker_id: workerId,
			timeout_ms: 30000,
		}),
	).toBeNull();
	expect(
		(
			await pool.query(
				"SELECT detail FROM prompt_optimization_events WHERE job_id = $1 AND status = 'stopped'",
				[jobId],
			)
		).rows,
	).toEqual([{ detail: { reason: "authorization_revoked" } }]);
});
