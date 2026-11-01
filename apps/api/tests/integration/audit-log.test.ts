import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import {
	LocalCredentialStore,
	provisionLocalBootstrap,
} from "../../src/db/local-credentials.js";
import { csrfForSession } from "../../src/db/local-sessions.js";
import { migrate } from "../../src/db/migrate.js";
import * as postgres from "../../src/db/postgres.js";

const secret = () => randomBytes(32).toString("base64url");
const timestamp = "2026-11-01T12:00:00.123456Z";
const ids = [
	"10000000-0000-4000-8000-000000000001",
	"10000000-0000-4000-8000-000000000002",
	"10000000-0000-4000-8000-000000000003",
	"10000000-0000-4000-8000-000000000004",
] as const;
const envKeys = [
	"GLASSHOUSE_AUTH_BOOTSTRAP_MODE",
	"GLASSHOUSE_BASIC_AUTH_CREDENTIALS",
	"GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME",
	"GLASSHOUSE_DEFAULT_ORGANIZATION_ID",
	"GLASSHOUSE_PUBLIC_ORIGIN",
	"UI_PASSWORD",
	"UI_USERNAME",
] as const;
const originalEnv = Object.fromEntries(
	envKeys.map((key) => [key, process.env[key]]),
);

let adminPool: Pool;
let pool: Pool;
let authenticationPool: Pool;
let database: string;
let poolSpy: ReturnType<typeof spyOn>;
let createApiApp: typeof import("../../src/index.js").createApiApp;

beforeAll(async () => {
	if (!process.env.DATABASE_URL)
		throw new Error("An isolated PostgreSQL DATABASE_URL is required");
	adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
	database = `audit_log_${randomUUID().replaceAll("-", "")}`;
	await adminPool.query(`CREATE DATABASE ${database}`);
	const url = new URL(process.env.DATABASE_URL);
	url.pathname = `/${database}`;
	pool = new Pool({ connectionString: url.toString(), max: 10 });
	authenticationPool = new Pool({ connectionString: url.toString(), max: 10 });
	await migrate({ DATABASE_URL: url.toString() });
	poolSpy = spyOn(postgres, "pgPool").mockReturnValue(pool);
	process.env.GLASSHOUSE_AUTH_BOOTSTRAP_MODE = "local";
	process.env.GLASSHOUSE_PUBLIC_ORIGIN = "https://glasshouse.example";
	delete process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
	delete process.env.GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME;
	delete process.env.UI_USERNAME;
	delete process.env.UI_PASSWORD;
	({ createApiApp } = await import("../../src/index.js"));
}, 60000);

afterAll(async () => {
	poolSpy?.mockRestore();
	for (const key of envKeys) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
	await authenticationPool?.end();
	await pool?.end();
	if (database) await adminPool.query(`DROP DATABASE ${database} WITH (FORCE)`);
	await adminPool?.end();
});

type Headers = Record<string, string>;

async function createOrganization(name: string) {
	const organizationId = randomUUID();
	const projectId = randomUUID();
	await pool.query(
		"WITH organization AS (INSERT INTO organizations(id, name, slug, default_project_id) VALUES ($1::uuid, $2, $1::text, $3::uuid) RETURNING id) INSERT INTO projects(id, organization_id, name, slug) SELECT $3, id, 'Default', 'default' FROM organization",
		[organizationId, name, projectId],
	);
	const store = new LocalCredentialStore(pool, organizationId);
	const setupSecret = secret();
	const password = secret();
	const adminUsername = `admin-${organizationId.replaceAll("-", "").slice(0, 16)}`;
	const useOrganization = () => {
		process.env.GLASSHOUSE_DEFAULT_ORGANIZATION_ID = organizationId;
	};
	await provisionLocalBootstrap(pool, organizationId, setupSecret);
	const admin = await store.bootstrap({
		username: adminUsername,
		password,
		token: setupSecret,
	});
	expect(await store.verify(adminUsername, password)).not.toBeNull();
	useOrganization();
	const api = createApiApp({
		pgPool: () => pool,
		authenticationPool: () => authenticationPool,
	});
	const publicRequest = (path: string, body: unknown) => {
		useOrganization();
		return api.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://glasshouse.example",
			},
			body: JSON.stringify(body),
		});
	};
	const login = async (username: string, loginPassword: string) => {
		useOrganization();
		const response = await publicRequest("/v1/auth/login", {
			username,
			password: loginPassword,
		});
		expect(response.status).toBe(200);
		const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
		const token = cookie.slice("glasshouse_session=".length);
		return {
			cookie,
			"content-type": "application/json",
			"x-glasshouse-csrf": csrfForSession(token),
			origin: "https://glasshouse.example",
		};
	};
	const adminHeaders = await login(adminUsername, password);
	const request = (
		path: string,
		method = "GET",
		body?: unknown,
		headers: Headers = adminHeaders,
	) => {
		useOrganization();
		return api.request(path, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	};
	const provision = async (username: string, role: "user" | "read_only") => {
		useOrganization();
		const response = await request("/v1/admin/local-accounts", "POST", {
			username,
			role,
		});
		expect(response.status).toBe(200);
		const account = (await response.json()) as {
			actor_id: string;
			code: string;
		};
		const accountPassword = secret();
		expect(
			(
				await publicRequest("/v1/auth/invitations/accept", {
					token: account.code,
					password: accountPassword,
				})
			).status,
		).toBe(200);
		return {
			actorId: account.actor_id,
			headers: await login(username, accountPassword),
		};
	};
	return {
		admin,
		adminHeaders,
		adminUsername,
		api,
		organizationId,
		projectId,
		provision,
		request,
	};
}

test("audit log uses a full-precision database cursor, current role checks, and scoped filters", async () => {
	const primary = await createOrganization("Audit");
	const foreign = await createOrganization("Foreign");
	const user = await primary.provision("audit.user", "user");
	const reader = await primary.provision("audit.reader", "read_only");

	const created = await primary.request("/v1/projects", "POST", {
		name: "Created by audit test",
		slug: "created-by-audit-test",
	});
	expect(created.status).toBe(201);
	const createdProject = (await created.json()) as { id: string };

	await pool.query(
		"INSERT INTO project_authorization_audit_events(id, organization_id, project_id, actor_subject, event_type, created_at) VALUES ($1::uuid, $4::uuid, $5::uuid, $6, 'project_updated', $7::timestamptz), ($2::uuid, $4::uuid, $5::uuid, $6, 'project_updated', $7::timestamptz), ($3::uuid, $4::uuid, $5::uuid, $6, 'project_updated', $7::timestamptz)",
		[
			ids[0],
			ids[1],
			ids[2],
			primary.organizationId,
			createdProject.id,
			primary.adminUsername,
			timestamp,
		],
	);
	await pool.query(
		"INSERT INTO project_authorization_audit_events(id, organization_id, project_id, actor_subject, event_type, created_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'project_updated', $5::timestamptz)",
		[
			randomUUID(),
			foreign.organizationId,
			foreign.projectId,
			foreign.adminUsername,
			timestamp,
		],
	);

	for (const headers of [primary.adminHeaders, user.headers, reader.headers]) {
		const response = await primary.api.request("/v1/audit-events?limit=100", {
			headers,
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			items: Array<{ resource_id: string | null }>;
		};
		expect(
			body.items.some((item) => item.resource_id === createdProject.id),
		).toBe(true);
		expect(
			body.items.some((item) => item.resource_id === foreign.projectId),
		).toBe(false);
	}

	const unauthenticated = await primary.api.request("/v1/audit-events");
	expect(unauthenticated.status).toBe(401);
	expect(
		(
			await primary.api.request(
				`/v1/audit-events?project_id=${foreign.projectId}`,
				{ headers: primary.adminHeaders },
			)
		).status,
	).toBe(400);

	const first = await primary.api.request(
		"/v1/audit-events?limit=2&action=project_updated&resource=project",
		{ headers: primary.adminHeaders },
	);
	expect(first.status).toBe(200);
	expect(first.headers.get("cache-control")).toBe("no-store");
	const firstPage = (await first.json()) as {
		items: Array<{ id: string; created_at: string }>;
		next_cursor: string;
	};
	expect(firstPage.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
	expect(firstPage.items.map((item) => item.created_at)).toEqual([
		timestamp,
		timestamp,
	]);
	const invalidCursors = [
		`${firstPage.next_cursor}x`,
		firstPage.next_cursor.replace(/^v1\./, "v2."),
		firstPage.next_cursor.replace(/\.2\./, ".3."),
	];
	for (const invalidCursor of invalidCursors) {
		const invalid = await primary.request(
			`/v1/audit-events?limit=2&action=project_updated&resource=project&cursor=${encodeURIComponent(invalidCursor)}`,
		);
		expect(invalid.status).toBe(400);
	}

	await pool.query(
		"INSERT INTO project_authorization_audit_events(id, organization_id, project_id, actor_subject, event_type, created_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'project_updated', $5::timestamptz)",
		[
			ids[3],
			primary.organizationId,
			createdProject.id,
			primary.adminUsername,
			timestamp,
		],
	);
	const continuation = await primary.api.request(
		`/v1/audit-events?limit=2&action=project_updated&resource=project&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
		{ headers: primary.adminHeaders },
	);
	expect(continuation.status).toBe(200);
	expect(
		((await continuation.json()) as { items: Array<{ id: string }> }).items.map(
			(item) => item.id,
		),
	).toEqual([ids[0]]);

	for (const request of [
		() =>
			primary.request(
				`/v1/audit-events?limit=2&action=project_created&resource=project&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
			),
		() =>
			primary.request(
				`/v1/audit-events?limit=2&action=project_updated&resource=project&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
				"GET",
				undefined,
				user.headers,
			),
		() =>
			foreign.request(
				`/v1/audit-events?limit=2&action=project_updated&resource=project&cursor=${encodeURIComponent(firstPage.next_cursor)}`,
			),
	]) {
		const replay = await request();
		expect(replay.status).toBe(400);
	}

	const fresh = await primary.api.request(
		"/v1/audit-events?limit=2&action=project_updated&resource=project",
		{ headers: primary.adminHeaders },
	);
	expect(
		((await fresh.json()) as { items: Array<{ id: string }> }).items.map(
			(item) => item.id,
		),
	).toEqual([ids[3], ids[2]]);

	const combined = await primary.api.request(
		`/v1/audit-events?from=2026-11-01T12%3A00%3A00.123456Z&to=2026-11-01T12%3A00%3A00.123456Z&actor=${primary.adminUsername}&action=project_updated&resource=${createdProject.id}&search=%25%27%20OR%201%3D1%20--`,
		{ headers: primary.adminHeaders },
	);
	expect(combined.status).toBe(200);
	expect((await combined.json()) as { items: unknown[] }).toEqual({
		items: [],
	});
}, 30000);

test("late commits do not enter an already admitted traversal", async () => {
	const organization = await createOrganization("Late commit snapshot");
	const [lateId, olderId, newestId] = [
		randomUUID(),
		randomUUID(),
		randomUUID(),
	].sort();
	const subject = `snapshot-${randomUUID()}`;
	const insert =
		"INSERT INTO project_authorization_audit_events(id, organization_id, project_id, actor_subject, event_type, created_at) VALUES ($1, $2, $3, $4, 'project_updated', $5)";
	for (const id of [olderId, newestId])
		await pool.query(insert, [
			id,
			organization.organizationId,
			organization.projectId,
			subject,
			timestamp,
		]);
	const writer = await pool.connect();
	try {
		await writer.query("BEGIN");
		await writer.query(insert, [
			lateId,
			organization.organizationId,
			organization.projectId,
			subject,
			timestamp,
		]);
		const params = new URLSearchParams({ limit: "1", actor: subject });
		const first = await organization.request(`/v1/audit-events?${params}`);
		expect(first.status).toBe(200);
		const page = (await first.json()) as {
			items: Array<{ id: string }>;
			next_cursor: string;
		};
		expect(page.items.map((item) => item.id)).toEqual([newestId]);
		await writer.query("COMMIT");
		params.set("cursor", page.next_cursor);
		const next = await organization.request(`/v1/audit-events?${params}`);
		expect(next.status).toBe(200);
		const continuation = (await next.json()) as {
			items: Array<{ id: string }>;
			next_cursor?: string;
		};
		expect(continuation.items.map((item) => item.id)).toEqual([olderId]);
		expect(continuation.next_cursor).toBeUndefined();
		const fresh = await organization.request(
			`/v1/audit-events?limit=100&actor=${subject}`,
		);
		expect(
			((await fresh.json()) as { items: Array<{ id: string }> }).items.map(
				(item) => item.id,
			),
		).toEqual([newestId, olderId, lateId]);
	} finally {
		await writer.query("ROLLBACK");
		writer.release();
	}
}, 30000);

test("snapshot retry, expiry, and role revocation fail closed", async () => {
	const organization = await createOrganization("Snapshot revocation");
	const user = await organization.provision("snapshot.user", "user");
	const subject = `snapshot-${randomUUID()}`;
	await pool.query(
		"INSERT INTO project_authorization_audit_events(organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'project_updated'), ($1, $2, $3, 'project_updated'), ($1, $2, $3, 'project_updated')",
		[organization.organizationId, organization.projectId, subject],
	);
	const params = new URLSearchParams({ limit: "1", actor: subject });
	const request = () =>
		organization.request(
			`/v1/audit-events?${params}`,
			"GET",
			undefined,
			user.headers,
		);
	const first = await request();
	expect(first.status).toBe(200);
	const page = (await first.json()) as { next_cursor: string };
	params.set("cursor", page.next_cursor);
	const second = await request();
	const retried = await request();
	expect(second.status).toBe(200);
	expect(await second.json()).toEqual(await retried.json());
	await pool.query(
		"UPDATE organization_actor_roles SET role = 'read_only' WHERE organization_id = $1 AND actor_id = $2",
		[organization.organizationId, user.actorId],
	);
	await pool.query(
		"UPDATE organization_actor_roles SET role = 'user' WHERE organization_id = $1 AND actor_id = $2",
		[organization.organizationId, user.actorId],
	);
	expect((await request()).status).toBe(400);
	params.delete("cursor");
	const again = await request();
	const newPage = (await again.json()) as { next_cursor: string };
	const snapshotId = newPage.next_cursor.split(".")[1];
	await pool.query(
		"UPDATE audit_log_snapshots SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
		[snapshotId],
	);
	params.set("cursor", newPage.next_cursor);
	expect((await request()).status).toBe(400);
}, 30000);

test("a continuation blocked behind a committed role change cannot use its old snapshot", async () => {
	const organization = await createOrganization("Snapshot role race");
	const user = await organization.provision("snapshot.race", "user");
	const subject = `snapshot-${randomUUID()}`;
	await pool.query(
		"INSERT INTO project_authorization_audit_events(organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'project_updated'), ($1, $2, $3, 'project_updated')",
		[organization.organizationId, organization.projectId, subject],
	);
	const params = new URLSearchParams({ limit: "1", actor: subject });
	const first = await organization.request(
		`/v1/audit-events?${params}`,
		"GET",
		undefined,
		user.headers,
	);
	expect(first.status).toBe(200);
	params.set(
		"cursor",
		((await first.json()) as { next_cursor: string }).next_cursor,
	);
	const writer = await pool.connect();
	let pending: Promise<Response> | undefined;
	try {
		await writer.query("BEGIN");
		await writer.query(
			"UPDATE organization_actor_roles SET role = 'read_only' WHERE organization_id = $1 AND actor_id = $2",
			[organization.organizationId, user.actorId],
		);
		pending = organization.request(
			`/v1/audit-events?${params}`,
			"GET",
			undefined,
			user.headers,
		);
		let waiting = false;
		for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
			const observation = await pool.query<{ waiting: boolean }>(
				"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%organization_actor_roles%' AND pid <> pg_backend_pid()) AS waiting",
			);
			waiting = observation.rows[0]!.waiting;
			if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(waiting).toBe(true);
		await writer.query("COMMIT");
		expect((await pending).status).toBe(400);
	} finally {
		await writer.query("ROLLBACK");
		writer.release();
		if (pending) await pending;
	}
}, 30000);

test("a project archive invalidates the traversal even after restoration", async () => {
	const organization = await createOrganization("Snapshot project revocation");
	const user = await organization.provision("snapshot.project", "user");
	const created = await organization.request("/v1/projects", "POST", {
		name: "Revocable",
		slug: "revocable",
	});
	expect(created.status).toBe(201);
	const project = (await created.json()) as { id: string };
	const subject = `snapshot-${randomUUID()}`;
	await pool.query(
		"INSERT INTO project_authorization_audit_events(organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'project_updated'), ($1, $2, $3, 'project_updated')",
		[organization.organizationId, project.id, subject],
	);
	const params = new URLSearchParams({ limit: "1", actor: subject });
	const first = await organization.request(
		`/v1/audit-events?${params}`,
		"GET",
		undefined,
		user.headers,
	);
	expect(first.status).toBe(200);
	params.set(
		"cursor",
		((await first.json()) as { next_cursor: string }).next_cursor,
	);
	await pool.query(
		"UPDATE projects SET status = 'archived' WHERE organization_id = $1 AND id = $2",
		[organization.organizationId, project.id],
	);
	const rejected = await organization.request(
		`/v1/audit-events?${params}`,
		"GET",
		undefined,
		user.headers,
	);
	expect(rejected.status).toBe(400);
	await pool.query(
		"UPDATE projects SET status = 'active' WHERE organization_id = $1 AND id = $2",
		[organization.organizationId, project.id],
	);
	expect(
		(
			await organization.request(
				`/v1/audit-events?${params}`,
				"GET",
				undefined,
				user.headers,
			)
		).status,
	).toBe(400);
}, 30000);

test("a read fence delays role revocation until snapshot admission commits", async () => {
	const organization = await createOrganization("Snapshot read fence");
	const user = await organization.provision("snapshot.fence", "user");
	const subject = `snapshot-${randomUUID()}`;
	await pool.query(
		"INSERT INTO project_authorization_audit_events(organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'project_updated'), ($1, $2, $3, 'project_updated')",
		[organization.organizationId, organization.projectId, subject],
	);
	const blocker = await pool.connect();
	const writer = await pool.connect();
	let pending: Promise<Response> | undefined;
	let revoke: Promise<unknown> | undefined;
	try {
		await blocker.query("BEGIN");
		await blocker.query(
			"SELECT pg_advisory_xact_lock(hashtext('glasshouse.audit_log_snapshots'))",
		);
		const params = new URLSearchParams({ limit: "1", actor: subject });
		pending = organization.request(
			`/v1/audit-events?${params}`,
			"GET",
			undefined,
			user.headers,
		);
		let readerWaiting = false;
		for (let attempt = 0; attempt < 100 && !readerWaiting; attempt++) {
			const observed = await pool.query<{ waiting: boolean }>(
				"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%glasshouse.audit_log_snapshots%' AND pid <> pg_backend_pid()) AS waiting",
			);
			readerWaiting = observed.rows[0]!.waiting;
			if (!readerWaiting)
				await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(readerWaiting).toBe(true);
		await writer.query("BEGIN");
		revoke = writer.query(
			"UPDATE organization_actor_roles SET role = 'read_only' WHERE organization_id = $1 AND actor_id = $2",
			[organization.organizationId, user.actorId],
		);
		let writerWaiting = false;
		for (let attempt = 0; attempt < 100 && !writerWaiting; attempt++) {
			const observed = await pool.query<{ waiting: boolean }>(
				"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'UPDATE organization_actor_roles SET role%' AND pid <> pg_backend_pid()) AS waiting",
			);
			writerWaiting = observed.rows[0]!.waiting;
			if (!writerWaiting)
				await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(writerWaiting).toBe(true);
		await blocker.query("COMMIT");
		const first = await pending;
		expect(first.status).toBe(200);
		const body = (await first.json()) as { next_cursor: string };
		await revoke;
		await writer.query("COMMIT");
		params.set("cursor", body.next_cursor);
		expect(
			(
				await organization.request(
					`/v1/audit-events?${params}`,
					"GET",
					undefined,
					user.headers,
				)
			).status,
		).toBe(400);
	} finally {
		await blocker.query("ROLLBACK");
		if (revoke) await revoke.catch(() => {});
		await writer.query("ROLLBACK");
		blocker.release();
		writer.release();
		if (pending) await pending;
	}
}, 30000);

test("snapshot quota rejects excess allocations and cleans expired snapshots", async () => {
	const organization = await createOrganization("Snapshot capacity");
	const subject = `snapshot-${randomUUID()}`;
	await pool.query(
		"INSERT INTO project_authorization_audit_events(organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'project_updated'), ($1, $2, $3, 'project_updated')",
		[organization.organizationId, organization.projectId, subject],
	);
	const params = new URLSearchParams({ limit: "1", actor: subject });
	const cursors: string[] = [];
	for (let i = 0; i < 8; i++) {
		const response = await organization.request(`/v1/audit-events?${params}`);
		expect(response.status).toBe(200);
		cursors.push(
			((await response.json()) as { next_cursor: string }).next_cursor,
		);
	}
	expect(
		(await organization.request(`/v1/audit-events?${params}`)).status,
	).toBe(503);
	await pool.query(
		"UPDATE audit_log_snapshots SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
		[cursors[0]!.split(".")[1]],
	);
	expect(
		(await organization.request(`/v1/audit-events?${params}`)).status,
	).toBe(200);
	params.set("cursor", cursors[0]!);
	expect(
		(await organization.request(`/v1/audit-events?${params}`)).status,
	).toBe(400);
	const count = await pool.query<{ count: number }>(
		"SELECT count(*)::int AS count FROM audit_log_snapshots WHERE organization_id = $1",
		[organization.organizationId],
	);
	expect(count.rows[0]!.count).toBe(8);
}, 30000);

test("oversized matching results fail explicitly rather than truncate", async () => {
	const organization = await createOrganization("Snapshot row capacity");
	const subject = `snapshot-${randomUUID()}`;
	await pool.query(
		"INSERT INTO project_authorization_audit_events(organization_id, project_id, actor_subject, event_type) SELECT $1, $2, $3, 'project_updated' FROM generate_series(1, 5001)",
		[organization.organizationId, organization.projectId, subject],
	);
	const response = await organization.request(
		`/v1/audit-events?limit=1&actor=${subject}`,
	);
	expect(response.status).toBe(503);
	const snapshots = await pool.query(
		"SELECT id FROM audit_log_snapshots WHERE organization_id = $1",
		[organization.organizationId],
	);
	expect(snapshots.rowCount).toBe(0);
}, 30000);

test("snapshot migration replays on a populated database without changing audit events", async () => {
	const organization = await createOrganization("Snapshot migration replay");
	const subject = `snapshot-${randomUUID()}`;
	await pool.query(
		"INSERT INTO project_authorization_audit_events(organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'project_updated')",
		[organization.organizationId, organization.projectId, subject],
	);
	const migration = await Bun.file(
		new URL(
			"../../../../infra/db/migrations/90062_audit_log_snapshots.sql",
			import.meta.url,
		),
	).text();
	await pool.query(migration);
	await pool.query(migration);
	const retained = await pool.query<{ count: number }>(
		"SELECT count(*)::int AS count FROM project_authorization_audit_events WHERE organization_id = $1 AND actor_subject = $2",
		[organization.organizationId, subject],
	);
	expect(retained.rows[0]!.count).toBe(1);
}, 30000);

test("populated 90061 upgrades without changing immutable audit evidence", async () => {
	const name = `audit_upgrade_${randomUUID().replaceAll("-", "")}`;
	await adminPool.query(`CREATE DATABASE ${name}`);
	const url = new URL(process.env.DATABASE_URL!);
	url.pathname = `/${name}`;
	const upgrade = new Pool({ connectionString: url.toString() });
	try {
		const dir = resolve(import.meta.dir, "../../../../infra/db/migrations");
		await runner({
			databaseUrl: url.toString(),
			dir,
			direction: "up",
			migrationsTable: "pgmigrations",
			migrationLoaderStrategies: [{ extensions: [".sql"], loader: "sql" }],
			count: (await readdir(dir)).filter(
				(filename) =>
					filename.endsWith(".sql") && Number(filename.split("_")[0]) < 90062,
			).length,
			singleTransaction: true,
			log: () => {},
		});
		const org = randomUUID(),
			project = randomUUID(),
			event = randomUUID();
		await upgrade.query(
			"WITH o AS (INSERT INTO organizations(id,name,slug,default_project_id) VALUES ($1,'Audit upgrade',$1::uuid::text,$2) RETURNING id) INSERT INTO projects(id,organization_id,name,slug) SELECT $2,id,'Default','default' FROM o",
			[org, project],
		);
		await upgrade.query(
			"INSERT INTO project_authorization_audit_events(id,organization_id,project_id,actor_subject,event_type) VALUES ($1,$2,$3,'upgrade-subject','project_updated')",
			[event, org, project],
		);
		await migrate({ DATABASE_URL: url.toString() });
		await migrate({ DATABASE_URL: url.toString() });
		const retained = await upgrade.query(
			"SELECT id,actor_subject FROM project_authorization_audit_events WHERE id = $1",
			[event],
		);
		expect(retained.rows).toEqual([
			{ id: event, actor_subject: "upgrade-subject" },
		]);
		const error = await upgrade
			.query(
				"UPDATE project_authorization_audit_events SET actor_subject = 'tampered' WHERE id = $1",
				[event],
			)
			.then(
				() => null,
				(cause) => cause,
			);
		expect(error).toMatchObject({
			code: "55000",
			message: "project authorization audit events are append-only",
		});
	} finally {
		await upgrade.end();
		await adminPool.query(`DROP DATABASE ${name} WITH (FORCE)`);
	}
}, 60000);

test("a continuation waiting for project archival fails closed after commit", async () => {
	const organization = await createOrganization("Snapshot project race");
	const user = await organization.provision("snapshot.projectrace", "user");
	const created = await organization.request("/v1/projects", "POST", {
		name: "Race project",
		slug: "race-project",
	});
	expect(created.status).toBe(201);
	const project = (await created.json()) as { id: string };
	const subject = `snapshot-${randomUUID()}`;
	await pool.query(
		"INSERT INTO project_authorization_audit_events(organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'project_updated'), ($1, $2, $3, 'project_updated')",
		[organization.organizationId, project.id, subject],
	);
	const params = new URLSearchParams({ limit: "1", actor: subject });
	const first = await organization.request(
		`/v1/audit-events?${params}`,
		"GET",
		undefined,
		user.headers,
	);
	expect(first.status).toBe(200);
	params.set(
		"cursor",
		((await first.json()) as { next_cursor: string }).next_cursor,
	);
	const writer = await pool.connect();
	let pending: Promise<Response> | undefined;
	try {
		await writer.query("BEGIN");
		await writer.query(
			"UPDATE projects SET status = 'archived' WHERE organization_id = $1 AND id = $2",
			[organization.organizationId, project.id],
		);
		pending = organization.request(
			`/v1/audit-events?${params}`,
			"GET",
			undefined,
			user.headers,
		);
		let waiting = false;
		for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
			const observed = await pool.query<{ waiting: boolean }>(
				"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM projects WHERE organization_id%' AND pid <> pg_backend_pid()) AS waiting",
			);
			waiting = observed.rows[0]!.waiting;
			if (!waiting) await Bun.sleep(20);
		}
		expect(waiting).toBe(true);
		await writer.query("COMMIT");
		expect((await pending).status).toBe(400);
	} finally {
		await writer.query("ROLLBACK");
		writer.release();
		if (pending) await pending;
	}
}, 30000);

test("a Project created while the authorization scope is locked fails closed", async () => {
	const organization = await createOrganization("Snapshot project phantom");
	const blocker = await pool.connect();
	const creator = await pool.connect();
	let pending: Promise<Response> | undefined;
	try {
		await blocker.query("BEGIN");
		await blocker.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [
			organization.projectId,
		]);
		pending = organization.request("/v1/audit-events?limit=1");
		let waiting = false;
		for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
			const observed = await pool.query<{ waiting: boolean }>(
				"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SELECT id FROM projects WHERE organization_id%' AND pid <> pg_backend_pid()) AS waiting",
			);
			waiting = observed.rows[0]!.waiting;
			if (!waiting) await Bun.sleep(20);
		}
		expect(waiting).toBe(true);
		await creator.query("SET statement_timeout = '3s'");
		await creator.query(
			"INSERT INTO projects(id, organization_id, name, slug) VALUES ($1, $2, 'New', 'new-during-read')",
			[randomUUID(), organization.organizationId],
		);
		await blocker.query("COMMIT");
		expect((await pending).status).toBe(503);
	} finally {
		await blocker.query("ROLLBACK");
		blocker.release();
		await creator.query("RESET statement_timeout");
		creator.release();
		if (pending) await pending;
	}
}, 30000);

test("Unicode filter pagination returns a reusable bounded cursor through the authenticated API", async () => {
	const organization = await createOrganization("Unicode cursor");
	const subject = "界".repeat(200);
	await pool.query(
		"INSERT INTO project_authorization_audit_events(organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'project_updated'), ($1, $2, $3, 'project_updated')",
		[organization.organizationId, organization.projectId, subject],
	);
	const params = new URLSearchParams({
		limit: "1",
		actor: subject,
		search: subject,
		action: "%".repeat(200),
		resource: "%".repeat(200),
		outcome: "%".repeat(200),
	});
	const first = await organization.request(`/v1/audit-events?${params}`);
	expect(first.status).toBe(200);
	const body = (await first.json()) as {
		items: Array<{ id: string }>;
		next_cursor: string;
	};
	expect(body.items).toHaveLength(1);
	expect(body.next_cursor.length).toBeLessThanOrEqual(2048);
	params.set("cursor", body.next_cursor);
	const second = await organization.request(`/v1/audit-events?${params}`);
	expect(second.status).toBe(200);
	const next = (await second.json()) as { items: Array<{ id: string }> };
	expect(next.items).toHaveLength(1);
	expect(next.items[0]!.id).not.toBe(body.items[0]!.id);
}, 30000);

test("time filters compare timestamps rather than their textual fractional precision", async () => {
	const organization = await createOrganization("Fractional time");
	await pool.query(
		"INSERT INTO project_authorization_audit_events(organization_id, project_id, actor_subject, event_type, created_at) VALUES ($1, $2, $3, 'project_updated', '2026-11-01T12:00:00.050Z')",
		[
			organization.organizationId,
			organization.projectId,
			organization.adminUsername,
		],
	);
	const valid = await organization.request(
		"/v1/audit-events?from=2026-11-01T12%3A00%3A00Z&to=2026-11-01T12%3A00%3A00.1Z&action=project_updated",
	);
	expect(valid.status).toBe(200);
	expect(((await valid.json()) as { items: unknown[] }).items).toHaveLength(1);
	const equal = await organization.request(
		"/v1/audit-events?from=2026-11-01T12%3A00%3A00.100Z&to=2026-11-01T12%3A00%3A00.1Z",
	);
	expect(equal.status).toBe(200);
	const invalid = await organization.request(
		"/v1/audit-events?from=2026-11-01T12%3A00%3A00.000002Z&to=2026-11-01T12%3A00%3A00.000001Z",
	);
	expect(invalid.status).toBe(400);
}, 30000);

test.each(["display", "filter"] as const)(
	"project creation resolves a local session actor for %s",
	async (mode) => {
		const organization = await createOrganization(`Actor ${mode}`);
		const created = await organization.request("/v1/projects", "POST", {
			name: "Actor identity project",
			slug: `actor-identity-${mode}`,
		});
		expect(created.status).toBe(201);
		const project = (await created.json()) as { id: string };
		const stored = await pool.query<{ actor_subject: string }>(
			"SELECT actor_subject FROM project_authorization_audit_events WHERE organization_id = $1 AND project_id = $2 AND event_type = 'project_created'",
			[organization.organizationId, project.id],
		);
		expect(stored.rows[0]?.actor_subject).toBe(
			`actor:${organization.admin.actorId}`,
		);
		const filter =
			mode === "filter"
				? `&actor=${encodeURIComponent(organization.adminUsername)}`
				: "";
		const response = await organization.request(
			`/v1/audit-events?limit=100&action=project_created&resource=${project.id}${filter}`,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			items: Array<{ actor: string; source: string }>;
		};
		const event = body.items.filter(
			(item) => item.source === "project_authorization",
		);
		expect(event).toHaveLength(1);
		expect(event[0]?.actor).toBe(organization.adminUsername);
	},
	30000,
);

test("ambiguous canonical Basic and local session subjects are not attributed to the wrong actor", async () => {
	const organization = await createOrganization("Ambiguous actor");
	const basicUsername = `actor：${organization.admin.actorId}`;
	const password = secret();
	process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = JSON.stringify([
		{
			username: basicUsername,
			password,
			organization_id: organization.organizationId,
		},
	]);
	process.env.GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME = basicUsername;
	try {
		const { bootstrapAuthorization } = await import(
			"../../src/db/bootstrap-authorization.js"
		);
		const { basicCredentialsFromEnvironment } = await import(
			"../../src/middleware/auth.js"
		);
		const basicActor = basicCredentialsFromEnvironment()[0]!;
		const url = new URL(process.env.DATABASE_URL!);
		url.pathname = `/${database}`;
		const isolatedPool = new Pool({ connectionString: url.toString() });
		await bootstrapAuthorization(process.env, isolatedPool);
		await pool.query(
			"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, 'admin')",
			[organization.organizationId, basicActor.actorId],
		);
		const api = createApiApp({
			pgPool: () => pool,
			authenticationPool: () => authenticationPool,
		});
		const sessionCreated = await api.request("/v1/projects", {
			method: "POST",
			headers: organization.adminHeaders,
			body: JSON.stringify({
				name: "Session project",
				slug: "session-collision",
			}),
		});
		expect(sessionCreated.status).toBe(201);
		const basicHeaders = {
			authorization: `Basic ${Buffer.from(`${basicUsername}:${password}`).toString("base64")}`,
			"content-type": "application/json",
		};
		const basicCreated = await api.request("/v1/projects", {
			method: "POST",
			headers: basicHeaders,
			body: JSON.stringify({ name: "Basic project", slug: "basic-collision" }),
		});
		expect(basicCreated.status).toBe(201);
		const sessionProject = (await sessionCreated.json()) as { id: string };
		const basicProject = (await basicCreated.json()) as { id: string };
		const response = await api.request(
			"/v1/audit-events?limit=100&action=project_created",
			{ headers: organization.adminHeaders },
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			items: Array<{ resource_id: string; actor: string; source: string }>;
		};
		const eventFor = (id: string) =>
			body.items.find(
				(event) =>
					event.source === "project_authorization" && event.resource_id === id,
			);
		expect(eventFor(sessionProject.id)?.actor).toBe("Unavailable");
		expect(eventFor(basicProject.id)?.actor).toBe(basicUsername);
	} finally {
		delete process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
		delete process.env.GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME;
	}
}, 30000);

test("subject resolution stays in the event organization and preserves unknown historical subjects", async () => {
	const primary = await createOrganization("Subject scope");
	const foreign = await createOrganization("Foreign subject");
	const subjects = [
		`actor:${foreign.admin.actorId}`,
		`actor:${randomUUID()}`,
		"legacy-subject",
		`actor:${primary.admin.actorId}:suffix`,
	];
	for (const subject of subjects) {
		await pool.query(
			"INSERT INTO project_authorization_audit_events(organization_id, project_id, actor_subject, event_type) VALUES ($1, $2, $3, 'project_updated')",
			[primary.organizationId, primary.projectId, subject],
		);
	}
	const response = await primary.request(
		`/v1/audit-events?limit=100&action=project_updated&resource=${primary.projectId}`,
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		items: Array<{ actor: string; source: string }>;
	};
	expect(
		body.items
			.filter((event) => event.source === "project_authorization")
			.map((event) => event.actor)
			.sort(),
	).toEqual(subjects.sort());
	const filtered = await primary.request(
		`/v1/audit-events?limit=100&action=project_updated&actor=${encodeURIComponent(foreign.adminUsername)}`,
	);
	expect(filtered.status).toBe(200);
	expect(((await filtered.json()) as { items: unknown[] }).items).toHaveLength(
		0,
	);
}, 30000);

test("prompt creation and versioning create visible, content-free user action events", async () => {
	const organization = await createOrganization("Prompt actions");
	const secretPrompt = "do not retain this prompt content";
	const created = await organization.request("/v1/prompts", "POST", {
		project_id: organization.projectId,
		name: "Support response",
		messages: [{ role: "system", content: secretPrompt }],
	});
	expect(created.status).toBe(201);
	const prompt = (await created.json()) as { id: string; version: number };
	const version = await organization.request(
		`/v1/prompts/${prompt.id}/versions?project_id=${organization.projectId}`,
		"POST",
		{
			base_version: prompt.version,
			messages: [{ role: "system", content: "a revised prompt" }],
			change_summary: "Revise response",
		},
	);
	expect(version.status).toBe(201);

	const stored = await pool.query<{
		action: string;
		organization_id: string;
		project_id: string;
		actor_id: string;
		prompt_id: string;
		prompt_version: number;
	}>(
		`SELECT action, organization_id, project_id, actor_id, prompt_id, prompt_version
		 FROM user_action_audit_events
		 WHERE project_id = $1
		 ORDER BY prompt_version`,
		[organization.projectId],
	);
	expect(stored.rows).toEqual([
		{
			action: "prompt_created",
			organization_id: organization.organizationId,
			project_id: organization.projectId,
			actor_id: organization.admin.actorId,
			prompt_id: expect.any(String),
			prompt_version: 1,
		},
		{
			action: "prompt_version_created",
			organization_id: organization.organizationId,
			project_id: organization.projectId,
			actor_id: organization.admin.actorId,
			prompt_id: expect.any(String),
			prompt_version: 2,
		},
	]);
	const history = await organization.request("/v1/audit-events?limit=100");
	expect(history.status).toBe(200);
	const historyBody = (await history.json()) as {
		items: Array<{ action: string; source: string }>;
	};
	expect(
		historyBody.items
			.filter((event) => event.source === "user_action")
			.map((event) => event.action)
			.sort(),
	).toEqual(["prompt_created", "prompt_version_created"]);
	expect(JSON.stringify(historyBody)).not.toContain(secretPrompt);
}, 30000);
