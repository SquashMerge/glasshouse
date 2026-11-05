import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { Pool } from "pg";
import { bootstrapAuthorization } from "../../src/db/bootstrap-authorization.js";
import { applyClickHouseMigrations } from "../../src/db/clickhouse-migrate.js";
import { migrate } from "../../src/db/migrate.js";
import { otlpDisposableDatastores } from "../helpers/otlp-disposable-datastores.js";
import { createOtlpIngestHandler } from "../../src/routes/otlp.js";
import {
	type TenantScope,
	withActiveAuthorizedProjectLock,
} from "../../src/tenancy.js";

const database = `otlp_extension_${randomUUID().replaceAll("-", "")}`;
const organizationId = randomUUID();
const projectId = randomUUID();
const otherProjectId = randomUUID();
const secret = "synthetic-secret-never-retain";
const bodyLimit = 1_048_576;
const envKeys = [
	"GLASSHOUSE_BASIC_AUTH_CREDENTIALS",
	"GLASSHOUSE_REDACT_INPUT",
	"GLASSHOUSE_REDACT_KEYS",
	"API_MAX_BODY_BYTES",
] as const;
const originalEnv = Object.fromEntries(
	envKeys.map((key) => [key, process.env[key]]),
);
let admin: Pool;
let pool: Pool;
let clickhouseAdmin: ClickHouseClient;
let clickhouse: ClickHouseClient;
let createdPostgres = false;
let createdClickhouse = false;
let server: ReturnType<typeof Bun.serve>;
let authorization: string;
const events: unknown[] = [];
const ingestErrors: Error[] = [];

beforeAll(async () => {
	const config = otlpDisposableDatastores(process.env, database);
	admin = new Pool({ connectionString: config.postgresAdminUrl });
	await admin.query(`CREATE DATABASE ${database}`);
	createdPostgres = true;
	pool = new Pool({ connectionString: config.postgresUrl, max: 10 });
	expect(
		(await pool.query("SELECT current_database() AS database")).rows[0]
			?.database,
	).toBe(database);
	await migrate({ DATABASE_URL: config.postgresUrl });
	clickhouseAdmin = createClient(config.clickhouseAdminOptions);
	await clickhouseAdmin.command({ query: `CREATE DATABASE ${database}` });
	createdClickhouse = true;
	clickhouse = createClient(config.clickhouseOptions);
	const selectedDatabase = await clickhouse.query({
		query: "SELECT currentDatabase() AS database",
		format: "JSONEachRow",
	});
	expect(
		(await selectedDatabase.json<{ database: string }>())[0]?.database,
	).toBe(database);
	await applyClickHouseMigrations(
		createClient(config.clickhouseOptions),
		async (run) => run(),
	);
	await pool.query(
		`WITH o AS (
			INSERT INTO organizations (id, name, slug, default_project_id)
			VALUES ($1::uuid, 'OTLP extension regression', $1::text, $2::uuid) RETURNING id
		) INSERT INTO projects (id, organization_id, name, slug)
		SELECT $2::uuid, id, 'Default', 'default' FROM o`,
		[organizationId, projectId],
	);
	const otherOrganizationId = randomUUID();
	await pool.query(
		`WITH o AS (
			INSERT INTO organizations (id, name, slug, default_project_id)
			VALUES ($1::uuid, 'Other organization', $1::text, $2::uuid) RETURNING id
		) INSERT INTO projects (id, organization_id, name, slug)
		SELECT $2::uuid, id, 'Default', 'default' FROM o`,
		[otherOrganizationId, otherProjectId],
	);
	const credential = {
		username: "otlp-extension-regression",
		password: randomBytes(32).toString("base64url"),
		organization_id: organizationId,
	};
	process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = JSON.stringify([credential]);
	process.env.GLASSHOUSE_REDACT_KEYS = "secret,enduser.id";
	process.env.GLASSHOUSE_REDACT_INPUT = "true";
	process.env.API_MAX_BODY_BYTES = String(bodyLimit);
	await bootstrapAuthorization({
		...process.env,
		DATABASE_URL: config.postgresUrl,
		GLASSHOUSE_AUTH_BOOTSTRAP_MODE: "basic",
		GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: credential.username,
	});
	authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
	const { createApiApp } = await import("../../src/index.js");
	const ingest = createOtlpIngestHandler({
		defaultClient: () => clickhouse,
		withActiveAuthorizedProjectLock: (tenant, callback) =>
			withActiveAuthorizedProjectLock(pool, tenant as TenantScope, callback),
		publishSync: (event, payload) => events.push({ event, payload }),
	});
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: createApiApp({
			pgPool: () => pool,
			authenticationPool: () => pool,
			handleOtlpIngest: async (...args) => {
				try {
					return await ingest(...args);
				} catch (error) {
					ingestErrors.push(error as Error);
					throw error;
				}
			},
		}).fetch,
	});
}, 60_000);

afterAll(async () => {
	server?.stop(true);
	await clickhouse?.close();
	await pool?.end();
	try {
		if (createdClickhouse)
			await clickhouseAdmin.command({
				query: `DROP DATABASE ${database} SYNC`,
			});
	} finally {
		try {
			if (createdPostgres)
				await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
		} finally {
			await clickhouseAdmin?.close();
			await admin?.end();
			for (const key of envKeys) {
				if (originalEnv[key] === undefined) delete process.env[key];
				else process.env[key] = originalEnv[key];
			}
		}
	}
});

function exportBody(depth: number, location = "value", provenance = projectId) {
	const traceId = randomBytes(16).toString("hex");
	const attribute = {
		key: "extension",
		...(location === "attribute" ? { futureExtension: "EXTENSION" } : {}),
		value: {
			stringValue: "drop-unknown-branch",
			...(location === "value" ? { futureExtension: "EXTENSION" } : {}),
		},
	};
	const body = JSON.stringify({
		resourceSpans: [
			{
				resource: {
					attributes: [
						{
							key: "glasshouse.project.id",
							value: { stringValue: provenance },
						},
					],
				},
				scopeSpans: [
					{
						spans: [
							{
								traceId,
								spanId: "0011223344556677",
								name: "extension-regression",
								startTimeUnixNano: "1700000000000000000",
								attributes: [
									attribute,
									{ key: "secret", value: { stringValue: secret } },
									{ key: "enduser.id", value: { stringValue: secret } },
									{
										key: "gen_ai.prompt.0.content",
										value: { stringValue: secret },
									},
									{
										key: "nested",
										value: {
											kvlistValue: {
												values: [
													{ key: "secret", value: { stringValue: secret } },
													{
														key: "safe",
														value: { stringValue: "retained-safe" },
													},
												],
											},
										},
									},
								],
							},
						],
					},
				],
			},
		],
	}).replace(
		'"EXTENSION"',
		'{"values":['.repeat(depth) +
			JSON.stringify({ secret }) +
			"]}".repeat(depth),
	);
	return { body, traceId };
}

async function post(body: string, project = projectId, auth = authorization) {
	return fetch(new URL("/v1/traces", server.url), {
		method: "POST",
		headers: {
			authorization: auth,
			"content-type": "application/json",
			"x-glasshouse-project-id": project,
		},
		body,
	});
}

for (const [depth, location] of [
	[100, "value"],
	[16_000, "value"],
	[20_000, "attribute"],
	[20_000, "value"],
	[32_000, "value"],
	[80_000, "value"],
] as const) {
	const { body, traceId } = exportBody(depth, location);
	test(`public ingest redacts unknown ${location} fields (${depth} wrappers, ${Buffer.byteLength(body)} bytes)`, async () => {
		ingestErrors.length = 0;
		expect(Buffer.byteLength(body)).toBeLessThan(bodyLimit);
		const response = await post(body);
		const responseBody = await response.text();
		expect(responseBody).not.toContain(secret);
		if (response.status === 500) {
			for (const table of ["traces", "observations"]) {
				const result = await clickhouse.query({
					query: `SELECT count() AS count FROM ${table} WHERE trace_id = {traceId:String}`,
					query_params: { traceId },
					format: "JSONEachRow",
				});
				const rows = await result.json<{ count: number | string }>();
				expect(Number(rows[0]?.count)).toBe(0);
			}
		}
		expect((await post("{}")).status).toBe(200);
		expect({
			status: response.status,
			errors: ingestErrors.map((e) => `${e.name}: ${e.message}`),
		}).toEqual({ status: 200, errors: [] });
		expect(responseBody).toBe("{}");
		expect((await post(body)).status).toBe(200);
		for (const table of ["traces", "observations"]) {
			const result = await clickhouse.query({
				query: `SELECT * FROM ${table} WHERE trace_id = {traceId:String}`,
				query_params: { traceId },
				format: "JSONEachRow",
			});
			const rows = await result.json<Record<string, unknown>>();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				organization_id: organizationId,
				project_id: projectId,
				input_text: "[REDACTED]",
			});
			const retained = JSON.stringify(rows);
			expect(retained).not.toContain(secret);
			expect(retained).not.toContain("drop-unknown-branch");
			if (table === "observations") {
				expect(retained).not.toContain("retained-safe");
				expect(retained).toContain("[REDACTED]");
			}
		}
		expect(JSON.stringify(events)).not.toContain(secret);
		expect(JSON.stringify(events)).not.toContain("drop-unknown-branch");
	});
}

test("deep extensions cannot bypass public authentication, tenant provenance, or body bounds", async () => {
	const { body } = exportBody(20_000);
	expect((await post(body, projectId, "")).status).toBe(401);
	expect((await post(body, otherProjectId)).status).toBe(404);
	expect(
		(await post(exportBody(20_000, "value", otherProjectId).body)).status,
	).toBe(404);
	expect(
		(await post(body + " ".repeat(bodyLimit - Buffer.byteLength(body) + 1)))
			.status,
	).toBe(413);
});
