import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
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
	expect(
		JSON.parse(Buffer.from(firstPage.next_cursor, "base64url").toString("utf8"))
			.created_at,
	).toBe(timestamp);

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
