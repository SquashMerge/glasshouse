import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
	LocalCredentialStore,
	provisionLocalBootstrap,
} from "../../src/db/local-credentials";
import { csrfForSession } from "../../src/db/local-sessions";
import { migrate } from "../../src/db/migrate";
import * as postgres from "../../src/db/postgres";

const secret = () => randomBytes(32).toString("base64url");
const envKeys = [
	"GLASSHOUSE_DEFAULT_ORGANIZATION_ID",
	"GLASSHOUSE_AUTH_BOOTSTRAP_MODE",
	"GLASSHOUSE_PUBLIC_ORIGIN",
	"GLASSHOUSE_BASIC_AUTH_CREDENTIALS",
	"GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME",
	"UI_USERNAME",
	"UI_PASSWORD",
] as const;
const originalEnv = Object.fromEntries(
	envKeys.map((key) => [key, process.env[key]]),
);
let adminPool: Pool;
let pool: Pool;
let fences: Pool;
let database: string;
let poolSpy: ReturnType<typeof spyOn>;
let createApiApp: typeof import("../../src/index").createApiApp;

beforeAll(async () => {
	if (!process.env.DATABASE_URL)
		throw new Error("Isolated real PostgreSQL is required");
	adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
	database = `accounts_${randomUUID().replaceAll("-", "")}`;
	await adminPool.query(`CREATE DATABASE ${database}`);
	const url = new URL(process.env.DATABASE_URL);
	url.pathname = `/${database}`;
	pool = new Pool({ connectionString: url.toString(), max: 12 });
	fences = new Pool({ connectionString: url.toString(), max: 12 });
	await migrate({ DATABASE_URL: url.toString() });
	poolSpy = spyOn(postgres, "pgPool").mockReturnValue(pool);
	process.env.GLASSHOUSE_AUTH_BOOTSTRAP_MODE = "local";
	process.env.GLASSHOUSE_PUBLIC_ORIGIN = "https://glasshouse.example";
	delete process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
	delete process.env.GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME;
	delete process.env.UI_USERNAME;
	delete process.env.UI_PASSWORD;
	({ createApiApp } = await import("../../src/index"));
}, 60000);
afterAll(async () => {
	poolSpy?.mockRestore();
	for (const key of envKeys) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
	await fences?.end();
	await pool?.end();
	if (database) await adminPool.query(`DROP DATABASE ${database} WITH (FORCE)`);
	await adminPool?.end();
});

async function fresh() {
	const id = randomUUID();
	const projectId = randomUUID();
	await pool.query(
		"WITH o AS (INSERT INTO organizations(id, name, slug, default_project_id) VALUES ($1::uuid, 'Accounts', $1::text, $2) RETURNING id) INSERT INTO projects(id, organization_id, name, slug) SELECT $2, id, 'Default', 'default' FROM o",
		[id, projectId],
	);
	process.env.GLASSHOUSE_DEFAULT_ORGANIZATION_ID = id;
	const store = new LocalCredentialStore(pool, id);
	const setupSecret = secret();
	const password = secret();
	await provisionLocalBootstrap(pool, id, setupSecret);
	const makeApi = () =>
		createApiApp({ pgPool: () => pool, authenticationPool: () => fences });
	const api = makeApi();
	const publicRequest = (path: string, input: unknown) =>
		api.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://glasshouse.example",
			},
			body: JSON.stringify(input),
		});
	const login = async (username = "test.admin", loginPassword = password) => {
		const response = await publicRequest("/v1/auth/login", {
			username,
			password: loginPassword,
		});
		if (!response.ok) throw new Error("Test login failed");
		const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
		const token = cookie.slice("glasshouse_session=".length);
		return {
			cookie,
			"x-glasshouse-csrf": csrfForSession(token),
			origin: "https://glasshouse.example",
			"content-type": "application/json",
		};
	};
	return {
		id,
		projectId,
		store,
		setupSecret,
		password,
		api,
		publicRequest,
		login,
		makeApi,
	};
}
async function fixture() {
	const f = await fresh();
	const principal = await f.store.bootstrap({
		username: "test.admin",
		password: f.password,
		token: f.setupSecret,
	});
	const headers = await f.login();
	const request = (
		path: string,
		method = "GET",
		input?: unknown,
		auth = headers,
	) =>
		f.api.request(path, {
			method,
			headers: auth,
			...(input === undefined ? {} : { body: JSON.stringify(input) }),
		});
	const provision = async (username = "test.user", role = "user") => {
		const response = await request("/v1/admin/local-accounts", "POST", {
			username,
			role,
		});
		expect(response.status).toBe(200);
		return (await response.json()) as {
			actor_id: string;
			username: string;
			enrollment_id: string;
			code: string;
		};
	};
	return { ...f, principal, headers, request, provision };
}

test("fresh HTTP setup chooses scope and closes across concurrent requests and app restart", async () => {
	const f = await fresh();
	expect(await (await f.api.request("/v1/auth/setup")).json()).toEqual({
		available: true,
	});
	const blocker = await pool.connect();
	await blocker.query("BEGIN");
	await blocker.query(
		"SELECT organization_id FROM local_bootstrap_controls WHERE organization_id = $1 FOR UPDATE",
		[f.id],
	);
	const input = {
		username: "test.admin",
		password: f.password,
		token: f.setupSecret,
	};
	const requests = [
		f.publicRequest("/v1/auth/setup", input),
		f.publicRequest("/v1/auth/setup", input),
	];
	let observed = false;
	try {
		for (let attempt = 0; attempt < 250; attempt++) {
			const result = await pool.query(
				`SELECT
					count(*) FILTER (WHERE query = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 98))')::int AS advisory_waiters,
					count(*) FILTER (WHERE query LIKE '%FROM local_bootstrap_controls%FOR UPDATE%')::int AS row_waiters
				FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
			);
			if (
				result.rows[0].advisory_waiters >= 1 &&
				result.rows[0].row_waiters >= 1
			) {
				observed = true;
				break;
			}
			await Bun.sleep(20);
		}
	} finally {
		await blocker.query("COMMIT");
		blocker.release();
		await Promise.allSettled(requests);
	}
	expect(observed).toBe(true);
	const responses = await Promise.all(requests);
	expect(responses.map((response) => response.status).sort()).toEqual([
		200, 401,
	]);
	const denied = responses.find((response) => response.status === 401)!;
	expect(await denied.json()).toEqual({
		code: "UNAUTHORIZED",
		message: "Authentication required",
	});
	expect(await (await f.makeApi().request("/v1/auth/setup")).json()).toEqual({
		available: false,
	});
	expect(
		(
			await f.publicRequest("/v1/auth/setup", {
				...input,
				organization_id: randomUUID(),
				role: "admin",
			})
		).status,
	).toBe(401);
	const headers = await f.login();
	const me = await (await f.api.request("/v1/me", { headers })).json();
	expect(me.organization_id).toBe(f.id);
	expect(me.organization_role).toBe("admin");
	expect(me.projects.map((project: { id: string }) => project.id)).toEqual([
		f.projectId,
	]);
	const counts = await pool.query(
		"SELECT (SELECT count(*)::int FROM local_credentials WHERE organization_id = $1) AS credentials, (SELECT count(*)::int FROM organization_memberships WHERE organization_id = $1) AS legacy_memberships, (SELECT count(*)::int FROM project_actor_grants WHERE organization_id = $1) AS grants",
		[f.id],
	);
	expect(counts.rows[0]).toEqual({
		credentials: 1,
		legacy_memberships: 0,
		grants: 0,
	});
}, 15000);

test("only same-organization current Admins may provision/list/manage, with CSRF and strict input", async () => {
	const f = await fixture();
	for (const method of ["GET", "POST"])
		expect(
			(await f.api.request("/v1/admin/local-accounts", { method })).status,
		).toBe(401);
	const noCsrf = { ...f.headers };
	delete (noCsrf as Record<string, string>)["x-glasshouse-csrf"];
	expect(
		(
			await f.request(
				"/v1/admin/local-accounts",
				"POST",
				{ username: "denied.user", role: "user" },
				noCsrf,
			)
		).status,
	).toBe(403);
	for (const input of [
		{ username: "Invalid Name", role: "user" },
		{ username: "valid.user", role: "owner" },
		{ username: "valid.user", role: "user", organization_id: randomUUID() },
		{ username: "valid.user", role: "user", email: "test@example.invalid" },
	])
		expect(
			(await f.request("/v1/admin/local-accounts", "POST", input)).status,
		).toBe(400);
	const account = await f.provision();
	const password = secret();
	await f.store.enroll(account.code, password);
	const userHeaders = await f.login("test.user", password);
	for (const [path, method, input] of [
		["/v1/admin/local-accounts", "GET", undefined],
		[
			"/v1/admin/local-accounts",
			"POST",
			{ username: "denied.user", role: "admin" },
		],
		[
			`/v1/admin/local-accounts/${f.principal.actorId}/status`,
			"PUT",
			{ enabled: false },
		],
		[`/v1/admin/local-accounts/${account.actor_id}/reset`, "POST", undefined],
		[
			`/v1/admin/local-enrollments/${account.enrollment_id}`,
			"DELETE",
			undefined,
		],
	] as const)
		expect((await f.request(path, method, input, userHeaders)).status).toBe(
			403,
		);
	for (const path of [
		`/v1/admin/local-accounts/${randomUUID()}/status`,
		`/v1/admin/local-accounts/${randomUUID()}/reset`,
	])
		expect(
			(
				await f.request(
					path,
					path.endsWith("status") ? "PUT" : "POST",
					path.endsWith("status") ? { enabled: false } : undefined,
				)
			).status,
		).toBe(409);
});

test("provision reveals one code, listing exposes only usernames/current roles/status, enrollment is single-use", async () => {
	const f = await fixture();
	const account = await f.provision("Test.Reader", "read_only");
	expect(Object.keys(account).sort()).toEqual([
		"actor_id",
		"code",
		"enrollment_id",
		"username",
	]);
	expect(account.username).toBe("test.reader");
	expect(account.code.length).toBe(43);
	const listing = await f.request("/v1/admin/local-accounts");
	expect(listing.headers.get("cache-control")).toBe("no-store");
	const body = await listing.json();
	const listed = body.items.find(
		(item: { actor_id: string }) => item.actor_id === account.actor_id,
	);
	expect(listed).toMatchObject({
		username: "test.reader",
		organization_role: "read_only",
		status: "pending",
		enrollments: [{ id: account.enrollment_id, status: "pending" }],
	});
	const serialized = JSON.stringify(body);
	for (const value of [
		account.code,
		"token_digest",
		"password_hash",
		"email",
		"password_algorithm",
	])
		expect(serialized.includes(value)).toBe(false);
	const password = secret();
	const enroll = () =>
		f.publicRequest("/v1/auth/invitations/accept", {
			token: account.code,
			password,
		});
	expect(await (await enroll()).json()).toEqual({ ok: true });
	expect((await enroll()).status).toBe(401);
	const headers = await f.login("TEST.READER", password);
	expect(
		(await f.request("/v1/auth/session", "GET", undefined, headers)).status,
	).toBe(200);
	expect(
		(await f.request("/v1/auth/logout", "POST", undefined, headers)).status,
	).toBe(200);
	expect(
		(await f.request("/v1/auth/session", "GET", undefined, headers)).status,
	).toBe(401);
	expect(
		(
			await f.request("/v1/admin/local-accounts", "POST", {
				username: "TEST.READER",
				role: "user",
			})
		).status,
	).toBe(409);
});

test("revoked/expired/disabled codes fail safely; disable/reset revoke sessions and re-enable never restores them", async () => {
	const f = await fixture();
	const pending = await f.provision("pending.user");
	expect(
		(
			await f.request(
				`/v1/admin/local-enrollments/${pending.enrollment_id}`,
				"DELETE",
			)
		).status,
	).toBe(200);
	const failure = { code: "UNAUTHORIZED", message: "Authentication required" };
	expect(
		await (
			await f.publicRequest("/v1/auth/invitations/accept", {
				token: pending.code,
				password: secret(),
			})
		).json(),
	).toEqual(failure);
	const account = await f.provision();
	const password = secret();
	await f.store.enroll(account.code, password);
	const headers = await f.login("test.user", password);
	expect(
		(
			await f.request(
				`/v1/admin/local-accounts/${account.actor_id}/status`,
				"PUT",
				{ enabled: false },
			)
		).status,
	).toBe(200);
	expect(
		(await f.request("/v1/auth/session", "GET", undefined, headers)).status,
	).toBe(401);
	expect(
		await (
			await f.publicRequest("/v1/auth/login", {
				username: "test.user",
				password,
			})
		).json(),
	).toEqual(failure);
	expect(
		(
			await f.request(
				`/v1/admin/local-accounts/${account.actor_id}/status`,
				"PUT",
				{ enabled: true },
			)
		).status,
	).toBe(200);
	expect(
		(await f.request("/v1/auth/session", "GET", undefined, headers)).status,
	).toBe(401);
	const currentHeaders = await f.login("test.user", password);
	const reset = await f.request(
		`/v1/admin/local-accounts/${account.actor_id}/reset`,
		"POST",
	);
	expect(reset.status).toBe(200);
	const replacement = await reset.json();
	expect(replacement.username).toBe("test.user");
	expect(
		(await f.request("/v1/auth/session", "GET", undefined, currentHeaders))
			.status,
	).toBe(401);
	expect(
		await (
			await f.publicRequest("/v1/auth/login", {
				username: "test.user",
				password,
			})
		).json(),
	).toEqual(failure);
	expect(
		(
			await f.publicRequest("/v1/auth/invitations/accept", {
				token: replacement.code,
				password: secret(),
			})
		).status,
	).toBe(200);
	const reissued = await (
		await f.request(
			`/v1/admin/local-accounts/${pending.actor_id}/reset`,
			"POST",
		)
	).json();
	await f.request(
		`/v1/admin/local-accounts/${pending.actor_id}/status`,
		"PUT",
		{ enabled: false },
	);
	expect(
		await (
			await f.publicRequest("/v1/auth/invitations/accept", {
				token: reissued.code,
				password: secret(),
			})
		).json(),
	).toEqual(failure);
});

test("last usable Admin guards reject disable, reset and demotion despite a pending replacement", async () => {
	const f = await fixture();
	const replacement = await f.provision("second.admin", "admin");
	for (const [path, method, input] of [
		[
			`/v1/admin/local-accounts/${f.principal.actorId}/status`,
			"PUT",
			{ enabled: false },
		],
		[
			`/v1/admin/local-accounts/${f.principal.actorId}/reset`,
			"POST",
			undefined,
		],
		[`/v1/admin/actors/${f.principal.actorId}/role`, "PUT", { role: "user" }],
	] as const)
		expect((await f.request(path, method, input)).status).toBe(409);
	expect((await f.request("/v1/auth/session")).status).toBe(200);
	await f.store.enroll(replacement.code, secret());
	expect(
		(
			await f.request(`/v1/admin/actors/${replacement.actor_id}/role`, "PUT", {
				role: "read_only",
			})
		).status,
	).toBe(200);
	expect(
		(
			await f.request(
				`/v1/admin/local-accounts/${f.principal.actorId}/reset`,
				"POST",
			)
		).status,
	).toBe(409);
	expect(
		(
			await f.request(`/v1/admin/actors/${replacement.actor_id}/role`, "PUT", {
				role: "admin",
			})
		).status,
	).toBe(200);
	expect(
		(
			await f.request(
				`/v1/admin/local-accounts/${f.principal.actorId}/status`,
				"PUT",
				{ enabled: false },
			)
		).status,
	).toBe(200);
	expect((await f.request("/v1/auth/session")).status).toBe(401);
});

test("cross-organization targets and expired codes never change the foreign account", async () => {
	const f = await fixture();
	const foreignId = randomUUID();
	await pool.query(
		"WITH o AS (INSERT INTO organizations(id, name, slug, default_project_id) VALUES ($1::uuid, 'Foreign', $1::text, $2) RETURNING id) INSERT INTO projects(id, organization_id, name, slug) SELECT $2, id, 'Default', 'default' FROM o",
		[foreignId, randomUUID()],
	);
	const foreign = new LocalCredentialStore(pool, foreignId);
	const token = secret();
	await provisionLocalBootstrap(pool, foreignId, token);
	const principal = await foreign.bootstrap({
		username: "foreign.admin",
		password: secret(),
		token,
	});
	const foreignAccount = await foreign.provision(principal, {
		username: "foreign.user",
		role: "user",
	});
	for (const [path, method, input] of [
		[
			`/v1/admin/local-accounts/${foreignAccount.actorId}/status`,
			"PUT",
			{ enabled: false },
		],
		[
			`/v1/admin/local-accounts/${foreignAccount.actorId}/reset`,
			"POST",
			undefined,
		],
		[
			`/v1/admin/local-enrollments/${foreignAccount.enrollmentId}`,
			"DELETE",
			undefined,
		],
	] as const)
		expect((await f.request(path, method, input)).status).toBe(409);
	expect(
		(
			await f.publicRequest("/v1/auth/invitations/accept", {
				token: foreignAccount.token,
				password: secret(),
			})
		).status,
	).toBe(401);
	const foreignState = await pool.query(
		"SELECT enabled, password_hash IS NULL AS pending FROM local_credentials WHERE actor_id = $1",
		[foreignAccount.actorId],
	);
	expect(foreignState.rows[0]).toEqual({ enabled: true, pending: true });
	const account = await f.provision("expired.user");
	await f.request(
		`/v1/admin/local-enrollments/${account.enrollment_id}`,
		"DELETE",
	);
	const expired = secret();
	await pool.query(
		"INSERT INTO local_account_enrollments(organization_id, actor_id, provisioned_by, kind, token_digest, created_at, expires_at) VALUES ($1, $2, $3, 'first_use', $4, now() - interval '8 days', now() - interval '1 day')",
		[
			f.id,
			account.actor_id,
			f.principal.actorId,
			createHash("sha256").update(expired).digest(),
		],
	);
	expect(
		(
			await f.publicRequest("/v1/auth/invitations/accept", {
				token: expired,
				password: secret(),
			})
		).status,
	).toBe(401);
	const listing = await (await f.request("/v1/admin/local-accounts")).json();
	expect(
		listing.items.some((item: { username: string }) =>
			item.username.startsWith("foreign."),
		),
	).toBe(false);
	expect(
		listing.items
			.find((item: { actor_id: string }) => item.actor_id === account.actor_id)
			.enrollments.some(
				(enrollment: { status: string }) => enrollment.status === "expired",
			),
	).toBe(true);
});

test("concurrent credential loss and role loss cannot leave zero usable Admins", async () => {
	const f = await fixture();
	const replacement = await f.provision("second.admin", "admin");
	const password = secret();
	await f.store.enroll(replacement.code, password);
	const otherHeaders = await f.login("second.admin", password);
	const blocker = await pool.connect();
	await blocker.query("BEGIN");
	await blocker.query(
		"SELECT actor_id FROM local_credentials WHERE organization_id = $1 ORDER BY actor_id FOR UPDATE",
		[f.id],
	);
	const operations = [
		f.request(
			`/v1/admin/local-accounts/${f.principal.actorId}/status`,
			"PUT",
			{ enabled: false },
			otherHeaders,
		),
		f.request(`/v1/admin/actors/${replacement.actor_id}/role`, "PUT", {
			role: "user",
		}),
	];
	let observed = false;
	try {
		for (let attempt = 0; attempt < 250; attempt++) {
			const waiting = await pool.query(
				"SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM local_credentials%'",
			);
			if (waiting.rows[0].count >= 2) {
				observed = true;
				break;
			}
			await Bun.sleep(20);
		}
	} finally {
		await blocker.query("COMMIT");
		blocker.release();
	}
	expect(observed).toBe(true);
	const results = await Promise.all(operations);
	expect(results.filter((response) => response.status === 200).length).toBe(1);
	const usable = await pool.query(
		"SELECT count(*)::int AS count FROM organization_actor_roles WHERE organization_id = $1 AND organization_actor_is_usable_admin(organization_id, actor_id)",
		[f.id],
	);
	expect(usable.rows[0].count).toBe(1);
}, 15000);
