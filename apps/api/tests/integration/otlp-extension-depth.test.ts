import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import { Pool } from "pg";
import {
	buildFeedbackTracePayload,
	buildTracePayload,
} from "../../../web/tests/fixtures/otlp-traces.js";
import { bootstrapAuthorization } from "../../src/db/bootstrap-authorization.js";
import { applyClickHouseMigrations } from "../../src/db/clickhouse-migrate.js";
import { migrate } from "../../src/db/migrate.js";
import { otlpDisposableDatastores } from "../helpers/otlp-disposable-datastores.js";
import { createOtlpIngestHandler } from "../../src/routes/otlp.js";
import { OtlpWireRequest } from "../../src/schemas/otlp.js";
import { publishSync } from "../../src/lib/event-bus.js";
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
	"DATABASE_URL",
	"CLICKHOUSE_URL",
	"CLICKHOUSE_DB",
	"CLICKHOUSE_USER",
	"CLICKHOUSE_PASSWORD",
	"VALKEY_PUBSUB_URL",
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
	delete process.env.VALKEY_PUBSUB_URL;
	await bootstrapAuthorization({
		...process.env,
		DATABASE_URL: config.postgresUrl,
		GLASSHOUSE_AUTH_BOOTSTRAP_MODE: "basic",
		GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: credential.username,
	});
	authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
	process.env.DATABASE_URL = config.postgresUrl;
	process.env.CLICKHOUSE_URL = config.clickhouseOptions.url;
	process.env.CLICKHOUSE_DB = database;
	process.env.CLICKHOUSE_USER = config.clickhouseOptions.username;
	process.env.CLICKHOUSE_PASSWORD = config.clickhouseOptions.password;
	const { createApiApp } = await import("../../src/index.js");
	const ingest = createOtlpIngestHandler({
		defaultClient: () => clickhouse,
		withActiveAuthorizedProjectLock: (tenant, callback) =>
			withActiveAuthorizedProjectLock(pool, tenant as TenantScope, callback),
		publishSync: (event, payload) => {
			events.push({ event, payload });
			publishSync(event, payload);
		},
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
	const { closeClickHouseClient } = await import("../../src/db/clickhouse.js");
	const { pgPool, authenticationPool } = await import(
		"../../src/db/postgres.js"
	);
	await closeClickHouseClient();
	await pgPool().end();
	await authenticationPool().end();
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

test("oversized retained OTLP detail opens SSE, stays live and remains complete only on authorized scoped REST reads", async () => {
	process.env.GLASSHOUSE_REDACT_INPUT = "false";
	const { body, traceId } = exportBody(0);
	const payload = JSON.parse(body);
	const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
	const text = "\u0001".repeat(8_192);
	span.attributes = ["input.value", "output.value"].map((key) => ({
		key,
		value: { stringValue: text },
	}));
	span.events = Array.from({ length: 4 }, () => ({
		name: "retained-event",
		attributes: [{ key: "detail", value: { stringValue: "x".repeat(8_192) } }],
	}));
	try {
		expect((await post(JSON.stringify(payload))).status).toBe(200);
		const path = `/v1/traces/${traceId}?project_id=${projectId}`;
		const read = (path: string, auth = authorization) =>
			fetch(new URL(path, server.url), { headers: { authorization: auth } });
		expect((await read(path, "")).status).toBe(401);
		expect(
			(await read(`/v1/traces/${traceId}?project_id=${otherProjectId}`)).status,
		).toBe(404);
		const full = await read(path);
		expect(full.status).toBe(200);
		const detail = (await full.json()) as {
			observations: Array<{
				input_text: string;
				output_text: string;
				otlp: unknown;
			}>;
		};
		expect(detail.observations[0]?.input_text).toBe(text);
		expect(detail.observations[0]?.output_text).toBe(text);
		expect(JSON.stringify(detail.observations[0]?.otlp)).toContain(
			"retained-event",
		);
		const stream = await read(
			`/v1/traces/${traceId}/events?project_id=${projectId}`,
		);
		expect(stream.status).toBe(200);
		const reader = stream.body!.getReader();
		let buffer = "";
		const decoder = new TextDecoder();
		const next = async (event: string) => {
			for (;;) {
				let boundary: number;
				while ((boundary = buffer.indexOf("\n\n")) >= 0) {
					const frame = buffer.slice(0, boundary + 2);
					buffer = buffer.slice(boundary + 2);
					if (frame.startsWith(`event: ${event}\n`)) {
						expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(65_536);
						return JSON.parse(frame.split("\ndata: ")[1]!);
					}
				}
				const chunk = await reader.read();
				if (chunk.done) throw new Error("SSE closed before expected event");
				buffer += decoder.decode(chunk.value, { stream: true });
			}
		};
		try {
			expect((await next("snapshot")).detail_omitted).toBe(true);
			span.spanId = "0011223344556678";
			expect((await post(JSON.stringify(payload))).status).toBe(200);
			const live = await next("observation");
			expect(live.detail_omitted).toBe(true);
			expect(live.observation.observation_id).toBe(span.spanId);
			expect(
				((await (await read(path)).json()) as { observations: unknown[] })
					.observations,
			).toHaveLength(2);
		} finally {
			await reader.cancel();
		}
	} finally {
		process.env.GLASSHOUSE_REDACT_INPUT = "true";
	}
});

test("public all_text ingestion retains only validated typed provenance and structural classification", async () => {
	const { body, traceId } = exportBody(0);
	const payload = JSON.parse(body);
	const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
	span.attributes.push(
		{ key: "openinference.span.kind", value: { stringValue: "LLM" } },
		{ key: "glasshouse.prompt.id", value: { stringValue: "support-agent" } },
		{ key: "glasshouse.prompt.version", value: { intValue: "7" } },
		{
			key: "glasshouse.prompt.content_hash",
			value: { stringValue: "a".repeat(64) },
		},
		{ key: "glasshouse.prompt.source", value: { stringValue: secret } },
	);
	expect((await post(JSON.stringify(payload))).status).toBe(200);
	const response = await fetch(
		new URL(`/v1/traces/${traceId}?project_id=${projectId}`, server.url),
		{ headers: { authorization } },
	);
	expect(response.status).toBe(200);
	const retained = await response.text();
	expect(retained).not.toContain(secret);
	expect(retained).not.toContain("glasshouse.prompt.");
	expect(JSON.parse(retained).observations[0]).toMatchObject({
		type: "generation",
		metadata: {
			prompt_provenance: {
				id: "support-agent",
				version: 7,
				content_hash: "a".repeat(64),
			},
		},
	});
	expect(JSON.stringify(events)).not.toContain(secret);
	expect(JSON.stringify(events)).not.toContain("glasshouse.prompt.");
});

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

for (const fixture of ["dataset-feedback-first-pass", "sse-live"] as const) {
	test(`public ingest accepts the actual ${fixture} browser trace fixture`, async () => {
		const traceId = randomBytes(16).toString("hex");
		const spanId = randomBytes(8).toString("hex");
		const payload =
			fixture === "dataset-feedback-first-pass"
				? buildFeedbackTracePayload({
						projectId,
						traceId,
						spanId,
						name: "browser-feedback-regression",
						input: { prompt: "browser input" },
						output: { completion: "browser output" },
					})
				: buildTracePayload(
						projectId,
						traceId,
						spanId,
						10,
						"browser-sse-regression",
					);
		const spans = payload.resourceSpans.flatMap((resource) =>
			resource.scopeSpans.flatMap((scope) => scope.spans),
		);
		expect(OtlpWireRequest.safeParse(payload).success).toBe(true);
		const body = JSON.stringify(payload);
		expect((await post(body, projectId, "")).status).toBe(401);
		expect((await post(body, otherProjectId)).status).toBe(404);
		const beforeEvents = events.length;
		for (const field of ["startTimeUnixNano", "endTimeUnixNano"]) {
			const unsafeBody = JSON.stringify(payload, (key, value) =>
				key === field ? Number(value) : value,
			);
			expect(OtlpWireRequest.safeParse(JSON.parse(unsafeBody)).success).toBe(
				false,
			);
			expect((await post(unsafeBody)).status).toBe(400);
		}
		for (const table of ["traces", "observations"]) {
			const result = await clickhouse.query({
				query: `SELECT count() AS count FROM ${table} WHERE trace_id = {traceId:String}`,
				query_params: { traceId },
				format: "JSONEachRow",
			});
			expect(Number((await result.json<{ count: string }>())[0]?.count)).toBe(
				0,
			);
		}
		expect(events.length).toBe(beforeEvents);
		const response = await post(body);
		expect({ status: response.status, body: await response.text() }).toEqual({
			status: 200,
			body: "{}",
		});
		const read = await fetch(
			new URL(`/v1/traces/${traceId}?project_id=${projectId}`, server.url),
			{ headers: { authorization } },
		);
		expect(read.status).toBe(200);
		const detail = (await read.json()) as {
			trace: { project_id: string };
			next_cursor?: string;
			observations: Array<{
				observation_id: string;
				parent_observation_id: string | null;
				project_id: string;
				start_time_unix_nano: string;
				end_time_unix_nano: string;
			}>;
		};
		let cursor = detail.next_cursor;
		const seenCursors = new Set<string>();
		while (cursor) {
			expect(seenCursors.has(cursor)).toBe(false);
			seenCursors.add(cursor);
			const next = await fetch(
				new URL(
					`/v1/traces/${traceId}?project_id=${projectId}&cursor=${encodeURIComponent(cursor)}`,
					server.url,
				),
				{ headers: { authorization } },
			);
			expect(next.status).toBe(200);
			const page = (await next.json()) as typeof detail;
			detail.observations.push(...page.observations);
			cursor = page.next_cursor;
		}
		expect(detail.trace.project_id).toBe(projectId);
		expect(detail.observations).toHaveLength(spans.length);
		for (const span of spans) {
			expect(BigInt(span.startTimeUnixNano)).toBeGreaterThan(
				BigInt(Number.MAX_SAFE_INTEGER),
			);
			expect(detail.observations).toContainEqual(
				expect.objectContaining({
					observation_id: span.spanId,
					project_id: projectId,
					start_time_unix_nano: span.startTimeUnixNano,
					end_time_unix_nano: span.endTimeUnixNano,
				}),
			);
		}
		if (fixture === "sse-live") {
			expect(
				detail.observations.filter(
					(span) => span.parent_observation_id === spanId,
				),
			).toHaveLength(9);
			const childPayload = buildTracePayload(
				projectId,
				traceId,
				spanId,
				1,
				"browser-sse-regression",
				1,
			);
			const child = childPayload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
			expect(child.parentSpanId).toBe(spanId);
			const beforeChildEvents = events.length;
			expect((await post(JSON.stringify(childPayload))).status).toBe(200);
			expect(events.slice(beforeChildEvents)).toContainEqual(
				expect.objectContaining({
					event: "observation.created",
					payload: expect.objectContaining({
						observation: expect.objectContaining({
							observation_id: child.spanId,
							parent_observation_id: spanId,
							project_id: projectId,
						}),
					}),
				}),
			);
		}
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

for (const variant of [
	"attribute-extension-switch",
	"value-extension-switch",
	"duplicate-identical",
	"malformed-id",
	"attribute-extension-only",
	"value-extension-only",
	"null-extension",
	"conflicting-values",
] as const) {
	test(`public ingest rejects ${variant} Project selectors before persistence or publication`, async () => {
		const { body, traceId } = exportBody(0);
		const payload = JSON.parse(body);
		const selector = payload.resourceSpans[0].resource.attributes[0];
		const selectors = [selector];
		if (variant.startsWith("attribute-extension"))
			selector.futureExtension = { secret };
		if (variant.startsWith("value-extension"))
			selector.value.futureExtension = { secret };
		if (variant === "null-extension") selector.value.futureExtension = null;
		if (variant === "conflicting-values") selector.value.boolValue = true;
		if (variant === "malformed-id") selector.value.stringValue = "invalid";
		if (variant.endsWith("switch") || variant === "duplicate-identical")
			selectors.push({
				key: "glasshouse.project.id",
				value: {
					stringValue:
						variant === "duplicate-identical" ? projectId : otherProjectId,
				},
			});
		payload.resourceSpans[0].resource.attributes = selectors;
		const bytes = JSON.stringify(payload);
		expect((await post(bytes, projectId, "")).status).toBe(401);
		const beforeEvents = events.length;
		const response = await post(bytes);
		for (const table of ["traces", "observations"]) {
			const result = await clickhouse.query({
				query: `SELECT project_id FROM ${table} WHERE trace_id = {traceId:String}`,
				query_params: { traceId },
				format: "JSONEachRow",
			});
			expect(await result.json()).toEqual([]);
		}
		expect(events.length).toBe(beforeEvents);
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain(secret);
	});
}
