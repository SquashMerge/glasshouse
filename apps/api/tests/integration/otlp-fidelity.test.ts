import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { Pool } from "pg";
import { otlpDisposableDatastores } from "../helpers/otlp-disposable-datastores.js";
import { migrate } from "../../src/db/migrate.js";
import { applyClickHouseMigrations } from "../../src/db/clickhouse-migrate.js";
import { bootstrapAuthorization } from "../../src/db/bootstrap-authorization.js";
import { startOtlpGrpcServer } from "../../src/lib/otlp-grpc.js";

const enabled = !!process.env.OTLP_SDK_PYTHON;
const integration = test.skipIf(!enabled);
const database = `otlp_extension_${randomUUID().replaceAll("-", "")}`;
const otherDatabase = `otlp_extension_${randomUUID().replaceAll("-", "")}`;
const organization = randomUUID();
const project = randomUUID();
const otherOrganization = randomUUID();
const otherProject = randomUUID();
const originalEnv = { ...process.env };
let admin: Pool;
let pool: Pool;
let chAdmin: ClickHouseClient;
let ch: ClickHouseClient;
let server: ReturnType<typeof Bun.serve>;
let closeGrpc: (() => Promise<void>) | null;
let createdPg = false;
const createdCh = new Set<string>();
let readAuth: string;
let otherAuth: string;
let ingestAuth: string;
let grpcPort: number;
let credentialId: string;
const directory = new URL("../../../../infra/db/clickhouse/", import.meta.url);

async function statements(client: ClickHouseClient, file: string) {
	for (const query of readFileSync(new URL(file, directory), "utf8")
		.replace(/^--.*$/gm, "")
		.split(";")
		.map((q) => q.trim())
		.filter(Boolean))
		await client.command({ query });
}
async function freePort(): Promise<number> {
	const socket = createServer();
	await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
	const port = (socket.address() as { port: number }).port;
	await new Promise<void>((resolve) => socket.close(() => resolve()));
	return port;
}

beforeAll(async () => {
	if (!enabled) return;
	const config = otlpDisposableDatastores(process.env, database);
	admin = new Pool({ connectionString: config.postgresAdminUrl });
	await admin.query(`CREATE DATABASE ${database}`);
	createdPg = true;
	pool = new Pool({ connectionString: config.postgresUrl });
	await migrate({ DATABASE_URL: config.postgresUrl });
	chAdmin = createClient(config.clickhouseAdminOptions);
	await chAdmin.command({ query: `CREATE DATABASE ${database}` });
	createdCh.add(database);
	ch = createClient(config.clickhouseOptions);
	// Populate the previous schema before the production migration runner upgrades it.
	for (const file of readdirSync(directory)
		.filter((file) => file.endsWith(".sql") && file < "0008")
		.sort())
		await statements(ch, file);
	await ch.insert({
		table: "observations",
		format: "JSONEachRow",
		values: [
			{
				observation_id: "legacy",
				trace_id: "legacy",
				organization_id: organization,
				project_id: project,
				start_time: "2023-11-14 22:13:20.000",
				duration_ms: 1,
			},
		],
	});
	await applyClickHouseMigrations(
		createClient(config.clickhouseOptions),
		async (run) => run(),
	);
	await applyClickHouseMigrations(
		createClient(config.clickhouseOptions),
		async (run) => run(),
	);
	await statements(ch, "0008_otlp_trace_fidelity.sql");
	for (const [org, proj] of [
		[organization, project],
		[otherOrganization, otherProject],
	]) {
		await pool.query(
			`WITH o AS (INSERT INTO organizations (id, name, slug, default_project_id) VALUES ($1::uuid, 'Synthetic fidelity', $1::text, $2::uuid) RETURNING id) INSERT INTO projects (id, organization_id, name, slug) SELECT $2::uuid, id, 'Default', 'default' FROM o`,
			[org, proj],
		);
	}
	const credentials = [organization, otherOrganization].map((org, index) => ({
		username: `fidelity-${index}`,
		password: randomBytes(32).toString("base64url"),
		organization_id: org,
	}));
	process.env.DATABASE_URL = config.postgresUrl;
	process.env.CLICKHOUSE_URL = config.clickhouseOptions.url;
	process.env.CLICKHOUSE_DB = database;
	process.env.CLICKHOUSE_USER = config.clickhouseOptions.username;
	process.env.CLICKHOUSE_PASSWORD = config.clickhouseOptions.password;
	process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = JSON.stringify(credentials);
	process.env.GLASSHOUSE_REDACT_KEYS = "secret";
	process.env.GLASSHOUSE_REDACT_INPUT = "false";
	for (const credential of credentials)
		await bootstrapAuthorization({
			...process.env,
			GLASSHOUSE_AUTH_BOOTSTRAP_MODE: "basic",
			GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: credential.username,
		});
	const auth = (index: number) =>
		`Basic ${Buffer.from(`${credentials[index]!.username}:${credentials[index]!.password}`).toString("base64")}`;
	readAuth = auth(0);
	otherAuth = auth(1);
	const { createApiApp } = await import("../../src/index.js");
	const app = createApiApp();
	server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
	grpcPort = await freePort();
	process.env.OTLP_GRPC_HOST = "127.0.0.1";
	process.env.OTLP_GRPC_PORT = String(grpcPort);
	closeGrpc = await startOtlpGrpcServer((request) => app.fetch(request));
	const response = await fetch(
		new URL("/v1/admin/otlp-credentials", server.url),
		{
			method: "POST",
			headers: { authorization: readAuth, "content-type": "application/json" },
			body: JSON.stringify({ project_id: project, name: "Synthetic fidelity" }),
		},
	);
	expect(response.status).toBe(201);
	const issued = (await response.json()) as {
		secret: string;
		credential: { id: string };
	};
	ingestAuth = `Bearer ${issued.secret}`;
	credentialId = issued.credential.id;
}, 60_000);

afterAll(async () => {
	if (!enabled) return;
	await closeGrpc?.();
	server?.stop(true);
	const { closeClickHouseClient } = await import("../../src/db/clickhouse.js");
	const { pgPool, authenticationPool } = await import(
		"../../src/db/postgres.js"
	);
	await closeClickHouseClient();
	await pgPool().end();
	await authenticationPool().end();
	await ch?.close();
	await pool?.end();
	for (const db of createdCh)
		await chAdmin.command({ query: `DROP DATABASE ${db} SYNC` });
	await chAdmin?.close();
	if (createdPg) await admin.query(`DROP DATABASE ${database}`);
	await admin?.end();
	for (const key of Object.keys(process.env))
		if (!(key in originalEnv)) delete process.env[key];
	Object.assign(process.env, originalEnv);
});

integration(
	"ClickHouse upgrade/replay preserves legacy rows without invented nanos; fresh schema matches",
	async () => {
		const result = await ch.query({
			query:
				"SELECT start_time_unix_nano, end_time_unix_nano, duration_nano, precise_duration_ms, otlp, duration_ms FROM observations WHERE observation_id = 'legacy'",
			format: "JSONEachRow",
		});
		expect(await result.json()).toEqual([
			{
				start_time_unix_nano: null,
				end_time_unix_nano: null,
				duration_nano: null,
				precise_duration_ms: null,
				otlp: "",
				duration_ms: 1,
			},
		]);
		await chAdmin.command({ query: `CREATE DATABASE ${otherDatabase}` });
		createdCh.add(otherDatabase);
		const config = otlpDisposableDatastores(originalEnv, otherDatabase);
		await applyClickHouseMigrations(
			createClient(config.clickhouseOptions),
			async (run) => run(),
		);
		const columns = async (db: string) => {
			const result = await chAdmin.query({
				query:
					"SELECT table, name, type, default_expression FROM system.columns WHERE database = {db:String} AND table IN ('traces','observations') ORDER BY table, position",
				query_params: { db },
				format: "JSONEachRow",
			});
			return result.json();
		};
		expect(await columns(otherDatabase)).toEqual(await columns(database));
	},
	30_000,
);

for (const transport of ["http", "grpc"])
	for (const allText of [false, true]) {
		integration(
			`official ${transport} SDK fidelity, exact nanos, redaction=${allText}, retry and authenticated tenant denial`,
			async () => {
				process.env.GLASSHOUSE_REDACT_INPUT = String(allText);
				const child = Bun.spawn(
					[
						process.env.OTLP_SDK_PYTHON!,
						new URL(
							"../../../../infra/scripts/otlp-fidelity-sdk.py",
							import.meta.url,
						).pathname,
					],
					{
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
						env: { PATH: process.env.PATH, PYTHONNOUSERSITE: "1" },
					},
				);
				child.stdin.write(
					JSON.stringify({
						transport,
						api: server.url.toString().replace(/\/$/, ""),
						grpc: `127.0.0.1:${grpcPort}`,
						project,
						other_project: otherProject,
						read_auth: readAuth,
						other_auth: otherAuth,
						ingest_auth: ingestAuth,
						all_text: allText,
					}),
				);
				child.stdin.end();
				const [stdout, stderr, exit] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
				const exported = JSON.parse(stdout);
				const rows = await ch.query({
					query:
						"SELECT count() AS count FROM observations WHERE trace_id = {id:String}",
					query_params: { id: exported.trace_id },
					format: "JSONEachRow",
				});
				expect(Number((await rows.json<{ count: string }>())[0]?.count)).toBe(
					2,
				);
			},
			30_000,
		);
	}

integration(
	"bounded JSON detail preserves counts, precision and every continuation page",
	async () => {
		process.env.GLASSHOUSE_REDACT_INPUT = "false";
		const id = randomBytes(16).toString("hex");
		const start = 1700000000000999999n;
		const text = "界".repeat(2_731);
		const attribute = (key: string, value: string) => ({
			key,
			value: { stringValue: value },
		});
		const spans = Array.from({ length: 12 }, (_, index) => ({
			traceId: id,
			spanId: (index + 1).toString(16).padStart(16, "0"),
			name: "bounded",
			startTimeUnixNano: (start + BigInt(index)).toString(),
			endTimeUnixNano: (start + BigInt(index) + 2n).toString(),
			flags: 769,
			traceState: "vendor=span",
			droppedAttributesCount: 3,
			droppedEventsCount: 4,
			droppedLinksCount: 5,
			status: { code: 2, message: "status" },
			attributes: [
				attribute("input.value", text),
				attribute("output.value", text),
			],
			events: [
				{
					name: "exception",
					timeUnixNano: "18446744073709551615",
					droppedAttributesCount: 6,
					attributes: [
						attribute("exception.message", text),
						attribute("exception.stacktrace", text),
					],
				},
			],
			links: [
				{
					traceId: id,
					spanId: "0011223344556677",
					flags: 513,
					traceState: "vendor=link",
					droppedAttributesCount: 7,
				},
			],
		}));
		const response = await fetch(new URL("/v1/traces", server.url), {
			method: "POST",
			headers: {
				authorization: ingestAuth,
				"x-glasshouse-project-id": project,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				resourceSpans: [
					{
						schemaUrl: "resource-schema",
						resource: { droppedAttributesCount: 8 },
						scopeSpans: [
							{
								schemaUrl: "scope-schema",
								scope: { name: "scope", droppedAttributesCount: 9 },
								spans,
							},
						],
					},
				],
			}),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({});
		let cursor: string | undefined;
		const seen = new Set<string>();
		let pages = 0;
		do {
			const url = new URL(`/v1/traces/${id}?project_id=${project}`, server.url);
			if (cursor) url.searchParams.set("cursor", cursor);
			const response = await fetch(url, {
				headers: { authorization: readAuth },
			});
			expect(response.status).toBe(200);
			const bytes = await response.text();
			expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(262_144);
			const page = JSON.parse(bytes);
			for (const row of page.observations) {
				expect(seen.has(row.observation_id)).toBe(false);
				seen.add(row.observation_id);
				expect(row.duration_nano).toBe("2");
				expect(row.duration_ms).toBe(0.000002);
				expect(row.otlp).toMatchObject({
					schema_version: 1,
					truncated: true,
					flags: 769,
					trace_state: "vendor=span",
					dropped_attributes_count: 3,
					dropped_events_count: 4,
					dropped_links_count: 5,
					resource: { dropped_attributes_count: 8 },
					scope: { dropped_attributes_count: 9 },
				});
				expect(Buffer.byteLength(JSON.stringify(row.otlp))).toBeLessThanOrEqual(
					32_768,
				);
			}
			cursor = page.next_cursor;
			expect(++pages).toBeLessThan(12);
		} while (cursor);
		expect(seen.size).toBe(12);
		expect(pages).toBeGreaterThan(1);
		await expect(
			ch.insert({
				table: "observations",
				format: "JSONEachRow",
				values: [
					{
						observation_id: "invalid",
						trace_id: id,
						organization_id: organization,
						project_id: project,
						start_time: "2023-11-14 22:13:20.000",
						otlp: "x".repeat(32_769),
					},
				],
			}),
		).rejects.toThrow();
	},
);

integration(
	"revoked ingestion credential cannot persist event/link spans",
	async () => {
		const revoked = await fetch(
			new URL(
				`/v1/admin/otlp-credentials/${credentialId}/revoke?project_id=${project}`,
				server.url,
			),
			{ method: "POST", headers: { authorization: readAuth } },
		);
		expect(revoked.status).toBe(200);
		const response = await fetch(new URL("/v1/traces", server.url), {
			method: "POST",
			headers: {
				authorization: ingestAuth,
				"x-glasshouse-project-id": project,
				"content-type": "application/json",
			},
			body: "{}",
		});
		expect(response.status).toBe(401);
	},
);
