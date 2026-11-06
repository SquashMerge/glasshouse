import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import * as grpc from "@grpc/grpc-js";
import protobufRoot from "@opentelemetry/otlp-proto-exporter-base/build/src/generated/root.js";
import { Pool } from "pg";
import { bootstrapAuthorization } from "../../src/db/bootstrap-authorization.js";
import { applyClickHouseMigrations } from "../../src/db/clickhouse-migrate.js";
import { closeClickHouseClient } from "../../src/db/clickhouse.js";
import { LocalCredentialStore } from "../../src/db/local-credentials.js";
import { csrfForSession } from "../../src/db/local-sessions.js";
import { migrate } from "../../src/db/migrate.js";
import { authenticationPool, pgPool } from "../../src/db/postgres.js";
import { startOtlpGrpcServer } from "../../src/lib/otlp-grpc.js";
import { durableActorId } from "../../src/middleware/auth.js";
import { otlpDisposableDatastores } from "../helpers/otlp-disposable-datastores.js";

// Upcoming contract: POST /v1/logs is OTLP; GET /v1/logs is a Project-authorized
// product read. ClickHouse logs retain AnyValue bodies and decimal nanosecond
// fields losslessly. Run this file alone so production client singletons target
// only its disposable databases, without module mocks or background recovery.
const database = `otlp_extension_${randomUUID().replaceAll("-", "")}`;
const organizationId = randomUUID();
const defaultProjectId = randomUUID();
const otherOrganizationId = randomUUID();
const otherDefaultProjectId = randomUUID();
const timestamp = "1700000000123456789";
const observedTimestamp = "1700000000987654321";
const bodyLimit = 1_048_576;
const logsExportPath =
	"/opentelemetry.proto.collector.logs.v1.LogsService/Export";
const syntheticSecret = "synthetic-logs-secret-never-retain";
const owner = {
	username: `logs-owner-${randomBytes(6).toString("hex")}`,
	password: randomBytes(32).toString("base64url"),
	organization_id: organizationId,
};
const outsider = {
	username: `logs-outsider-${randomBytes(6).toString("hex")}`,
	password: randomBytes(32).toString("base64url"),
	organization_id: otherOrganizationId,
};
const basic = (credential: typeof owner) =>
	`Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
const envKeys = [
	"DATABASE_URL",
	"CLICKHOUSE_URL",
	"CLICKHOUSE_DB",
	"CLICKHOUSE_USER",
	"CLICKHOUSE_PASSWORD",
	"GLASSHOUSE_BASIC_AUTH_CREDENTIALS",
	"GLASSHOUSE_AUTH_BOOTSTRAP_MODE",
	"GLASSHOUSE_DEFAULT_ORGANIZATION_ID",
	"GLASSHOUSE_PUBLIC_ORIGIN",
	"GLASSHOUSE_REDACT_INPUT",
	"GLASSHOUSE_REDACT_KEYS",
	"API_MAX_BODY_BYTES",
	"OTLP_GRPC_PORT",
	"OTLP_GRPC_HOST",
	"OTLP_GRPC_MAX_RECEIVE_BYTES",
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
let applicationClientsStarted = false;
let server: ReturnType<typeof Bun.serve>;
let stopGrpc: Awaited<ReturnType<typeof startOtlpGrpcServer>>;
let grpcClient: grpc.Client;
let grpcEndpoint: string;

type AnyValue = {
	stringValue?: string;
	boolValue?: boolean;
	intValue?: string;
	doubleValue?: number;
	bytesValue?: string;
	arrayValue?: { values: AnyValue[] };
	kvlistValue?: { values: Attribute[] };
};
type Attribute = { key: string; value: AnyValue };
type LogRecord = {
	timeUnixNano?: string;
	observedTimeUnixNano?: string;
	severityNumber?: number;
	severityText?: string;
	body?: AnyValue;
	attributes?: Attribute[];
	traceId?: string;
	spanId?: string;
	flags?: number;
	droppedAttributesCount?: number;
};
type LogRow = {
	log_id: string;
	project_id: string;
	time_unix_nano: string;
	observed_time_unix_nano: string;
	severity_number: number;
	severity_text: string;
	trace_id: string | null;
	span_id: string | null;
	flags: number;
	dropped_attributes_count: number;
	body: AnyValue;
	attributes: Attribute[];
	resource: { attributes: Attribute[] };
	scope: { name: string; version: string; attributes: Attribute[] };
};
const logProto = (
	protobufRoot as unknown as {
		opentelemetry: {
			proto: {
				collector: {
					logs: {
						v1: {
							ExportLogsServiceRequest: {
								fromObject(value: object): object;
								encode(value: object): { finish(): Uint8Array };
							};
							ExportLogsServiceResponse: {
								decode(value: Uint8Array): {
									partialSuccess?: {
										rejectedLogRecords: { toString(): string };
									};
								};
							};
						};
					};
				};
			};
		};
	}
).opentelemetry.proto.collector.logs.v1;

beforeAll(async () => {
	const config = otlpDisposableDatastores(process.env, database);
	admin = new Pool({ connectionString: config.postgresAdminUrl });
	await admin.query(`CREATE DATABASE ${database}`);
	createdPostgres = true;
	pool = new Pool({ connectionString: config.postgresUrl, max: 12 });
	expect(
		(await pool.query("SELECT current_database() AS name")).rows[0]?.name,
	).toBe(database);
	await migrate({ DATABASE_URL: config.postgresUrl });
	clickhouseAdmin = createClient(config.clickhouseAdminOptions);
	await clickhouseAdmin.command({ query: `CREATE DATABASE ${database}` });
	createdClickhouse = true;
	clickhouse = createClient(config.clickhouseOptions);
	const selected = await clickhouse.query({
		query: "SELECT currentDatabase() AS name",
		format: "JSONEachRow",
	});
	expect((await selected.json<{ name: string }>())[0]?.name).toBe(database);
	await applyClickHouseMigrations(
		createClient(config.clickhouseOptions),
		async (run) => run(),
	);
	for (const [org, project] of [
		[organizationId, defaultProjectId],
		[otherOrganizationId, otherDefaultProjectId],
	]) {
		await pool.query(
			`WITH o AS (
				INSERT INTO organizations (id, name, slug, default_project_id)
				VALUES ($1::uuid, 'OTLP logs regression', $1::text, $2::uuid) RETURNING id
			) INSERT INTO projects (id, organization_id, name, slug)
			SELECT $2::uuid, id, 'Default', 'default' FROM o`,
			[org, project],
		);
	}
	process.env.DATABASE_URL = config.postgresUrl;
	process.env.CLICKHOUSE_URL = config.clickhouseOptions.url;
	process.env.CLICKHOUSE_DB = database;
	process.env.CLICKHOUSE_USER = config.clickhouseOptions.username;
	process.env.CLICKHOUSE_PASSWORD = config.clickhouseOptions.password;
	process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = JSON.stringify([
		owner,
		outsider,
	]);
	process.env.GLASSHOUSE_AUTH_BOOTSTRAP_MODE = "basic";
	process.env.GLASSHOUSE_DEFAULT_ORGANIZATION_ID = organizationId;
	delete process.env.GLASSHOUSE_PUBLIC_ORIGIN;
	process.env.GLASSHOUSE_REDACT_INPUT = "false";
	process.env.GLASSHOUSE_REDACT_KEYS = "secret";
	process.env.API_MAX_BODY_BYTES = String(bodyLimit);
	for (const credential of [owner, outsider]) {
		await bootstrapAuthorization({
			...process.env,
			GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: credential.username,
		});
	}
	const { createApiApp } = await import("../../src/index.js");
	const app = createApiApp();
	applicationClientsStarted = true;
	server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
	const port = await unusedLoopbackPort();
	process.env.OTLP_GRPC_PORT = String(port);
	process.env.OTLP_GRPC_HOST = "127.0.0.1";
	process.env.OTLP_GRPC_MAX_RECEIVE_BYTES = String(bodyLimit);
	stopGrpc = await startOtlpGrpcServer(app.fetch);
	expect(stopGrpc).not.toBeNull();
	grpcEndpoint = `127.0.0.1:${port}`;
	grpcClient = new grpc.Client(grpcEndpoint, grpc.credentials.createInsecure());
}, 60_000);

afterAll(async () => {
	grpcClient?.close();
	await stopGrpc?.();
	server?.stop(true);
	try {
		if (applicationClientsStarted) {
			await closeClickHouseClient();
			await authenticationPool().end();
			await pgPool().end();
		}
		await clickhouse?.close();
		await pool?.end();
	} finally {
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
	}
});

async function unusedLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = createServer();
		socket.once("error", reject);
		socket.listen(0, "127.0.0.1", () => {
			const address = socket.address();
			if (!address || typeof address === "string") {
				socket.close();
				reject(new Error("Could not allocate a loopback port"));
				return;
			}
			socket.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}

async function request(path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	if (!headers.has("authorization")) headers.set("authorization", basic(owner));
	return fetch(new URL(path, server.url), {
		...init,
		headers,
		signal: AbortSignal.timeout(10_000),
	});
}

async function jsonPost(
	path: string,
	body: unknown,
	headers: HeadersInit = {},
) {
	const merged = new Headers(headers);
	merged.set("content-type", "application/json");
	return request(path, {
		method: "POST",
		headers: merged,
		body: JSON.stringify(body),
	});
}

async function project() {
	const name = `logs-${randomUUID()}`;
	const response = await jsonPost("/v1/projects", { name, slug: name });
	expect(response.status).toBe(201);
	const created = (await response.json()) as { id: string; name: string };
	expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
	return created;
}

async function credential(projectId: string, headers: HeadersInit = {}) {
	const response = await jsonPost(
		"/v1/admin/otlp-credentials",
		{ project_id: projectId, name: "logs regression" },
		headers,
	);
	expect(response.status).toBe(201);
	return (await response.json()) as {
		credential: { id: string };
		secret: string;
	};
}

function record(marker: string, changes: Partial<LogRecord> = {}): LogRecord {
	return {
		timeUnixNano: timestamp,
		observedTimeUnixNano: observedTimestamp,
		severityNumber: 13,
		severityText: "WARN",
		body: { stringValue: marker },
		attributes: [{ key: "test.marker", value: { stringValue: marker } }],
		...changes,
	};
}

function envelope(
	records: LogRecord[],
	resourceAttributes: Attribute[] = [],
	scopeAttributes: Attribute[] = [],
) {
	return {
		resourceLogs: [
			{
				resource: { attributes: resourceAttributes },
				scopeLogs: [
					{
						scope: {
							name: "glasshouse.logs.test",
							version: "1.0",
							attributes: scopeAttributes,
						},
						logRecords: records,
					},
				],
			},
		],
	};
}

function protobuf(body: ReturnType<typeof envelope>): Buffer {
	const wire = structuredClone(body);
	// ProtoJSON IDs are hex; the generated protobuf encoder accepts bytes/base64.
	for (const resource of wire.resourceLogs)
		for (const scope of resource.scopeLogs)
			for (const log of scope.logRecords) {
				if (log.traceId)
					log.traceId = Buffer.from(log.traceId, "hex").toString("base64");
				if (log.spanId)
					log.spanId = Buffer.from(log.spanId, "hex").toString("base64");
			}
	return Buffer.from(
		logProto.ExportLogsServiceRequest.encode(
			logProto.ExportLogsServiceRequest.fromObject(wire),
		).finish(),
	);
}

async function ingest(
	projectId: string,
	body: unknown,
	headers: Record<string, string> = {},
) {
	return jsonPost("/v1/logs", body, {
		"x-glasshouse-project-id": projectId,
		...headers,
	});
}

async function list(projectId: string, headers: HeadersInit = {}, query = "") {
	const response = await request(
		`/v1/logs?project_id=${projectId}&limit=200${query}`,
		{ headers },
	);
	expect(response.status).toBe(200);
	const result = (await response.json()) as { items: LogRow[]; total: number };
	expect(Array.isArray(result.items)).toBe(true);
	return result;
}

async function stored(projectId: string) {
	const result = await clickhouse.query({
		// Cast inside ClickHouse: converting a decoded JS number would hide lost nanos.
		query: `SELECT log_id, organization_id, project_id,
			CAST(time_unix_nano AS String) AS time_unix_nano,
			CAST(observed_time_unix_nano AS String) AS observed_time_unix_nano,
			CAST(ingested_time_unix_nano AS String) AS ingested_time_unix_nano,
			CAST(effective_time_unix_nano AS String) AS effective_time_unix_nano,
			severity_number, severity_text, trace_id, span_id, flags,
			dropped_attributes_count, event_name, body, attributes, resource, scope,
			resource_schema_url, scope_schema_url
			FROM logs WHERE project_id = {projectId:String}`,
		query_params: { projectId },
		format: "JSONEachRow",
	});
	return result.json<Record<string, unknown>>();
}

function metadata(auth: string | null, projectId: string | null) {
	const result = new grpc.Metadata();
	if (auth !== null) result.set("authorization", auth);
	if (projectId !== null) result.set("x-glasshouse-project-id", projectId);
	return result;
}

function unary(
	body: Buffer,
	headers: grpc.Metadata,
	path = logsExportPath,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		grpcClient.makeUnaryRequest(
			path,
			(value: Buffer) => value,
			(value: Buffer) => value,
			body,
			headers,
			{ deadline: Date.now() + 5_000 },
			(error, response) => (error ? reject(error) : resolve(response)),
		);
	});
}

async function policy(
	projectId: string,
	redaction: { mode: "none" | "all_text"; keys: string[] },
	retention: Record<string, number> = { logs: 1 },
) {
	const draft = await jsonPost("/v1/governance/policy/drafts", {
		project_id: projectId,
		redaction,
		retention,
	});
	expect(draft.status).toBe(201);
	const { policy: version } = (await draft.json()) as {
		policy: { id: string };
	};
	const approved = await jsonPost(
		`/v1/governance/policy/${version.id}/approve?project_id=${projectId}`,
		{},
	);
	expect(approved.status).toBe(200);
	return version.id;
}

async function localAccount(role: "admin" | "user" | "read_only") {
	const store = new LocalCredentialStore(pool, organizationId);
	const username = `logs.local.${randomBytes(6).toString("hex")}`;
	const provisioned = await store.provision(
		{ organizationId, actorId: durableActorId(owner.username) },
		{ username, role },
	);
	const password = randomBytes(32).toString("base64url");
	await store.enroll(provisioned.token, password);
	const login = await jsonPost("/v1/auth/login", { username, password });
	expect(login.status).toBe(200);
	const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
	const token = cookie.slice("glasshouse_session=".length);
	return {
		actorId: provisioned.actorId,
		headers: { cookie, "x-glasshouse-csrf": csrfForSession(token) },
	};
}

async function sdkExport(
	transport: "http" | "grpc",
	projectId: string,
	authorization: string | null,
) {
	const marker = `real-sdk-${randomUUID()}`;
	const traceId = randomBytes(16).toString("hex");
	const spanId = randomBytes(8).toString("hex");
	const child = Bun.spawn(
		[
			process.env.OTLP_LOGS_TEST_PYTHON ?? "python3",
			fileURLToPath(new URL("../fixtures/otlp-logs-sdk.py", import.meta.url)),
		],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: process.env.PATH, PYTHONNOUSERSITE: "1" },
		},
	);
	const timeout = setTimeout(() => child.kill(), 15_000);
	try {
		child.stdin.write(
			JSON.stringify({
				transport,
				endpoint: transport === "http" ? server.url.origin : grpcEndpoint,
				project_id: projectId,
				authorization,
				marker,
				trace_id: traceId,
				span_id: spanId,
				time_unix_nano: timestamp,
				observed_time_unix_nano: observedTimestamp,
			}),
		);
		child.stdin.end();
		const [stdout, , code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(
			code,
			"SDK fixture must run with infra/otlp-sdk-requirements.txt",
		).toBe(0);
		const result = JSON.parse(stdout) as {
			exported: boolean;
			attempts: number;
		};
		expect(result.attempts).toBe(1);
		return { ...result, marker, traceId, spanId };
	} finally {
		clearTimeout(timeout);
		child.kill();
	}
}

test("standard JSON logs persist with trusted scope, resource/scope metadata, and exact nanoseconds", async () => {
	const target = await project();
	const traceId = randomBytes(16).toString("hex");
	const spanId = randomBytes(8).toString("hex");
	const marker = `json-${randomUUID()}`;
	const body: AnyValue = {
		kvlistValue: {
			values: [
				{ key: "message", value: { stringValue: marker } },
				{ key: "large", value: { intValue: "9223372036854775807" } },
				{ key: "binary", value: { bytesValue: "AP+A" } },
				{
					key: "steps",
					value: {
						arrayValue: {
							values: [{ boolValue: true }, { doubleValue: 1.25 }, {}],
						},
					},
				},
			],
		},
	};
	const response = await ingest(
		target.id,
		envelope(
			[
				record(marker, {
					body,
					traceId: traceId.toUpperCase(),
					spanId: spanId.toUpperCase(),
					flags: 1,
					droppedAttributesCount: 2,
				}),
			],
			[
				{ key: "service.name", value: { stringValue: "real-log-service" } },
				{
					key: "glasshouse.organization.id",
					value: { stringValue: otherOrganizationId },
				},
			],
			[{ key: "scope.safe", value: { stringValue: "scope-retained" } }],
		),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("application/json");
	expect(await response.json()).toEqual({});
	const result = await list(target.id);
	expect(result.items).toHaveLength(1);
	expect(result.items[0]).toMatchObject({
		project_id: target.id,
		time_unix_nano: timestamp,
		observed_time_unix_nano: observedTimestamp,
		severity_number: 13,
		severity_text: "WARN",
		trace_id: traceId,
		span_id: spanId,
		flags: 1,
		dropped_attributes_count: 2,
		body,
		resource: {
			attributes: expect.arrayContaining([
				{ key: "service.name", value: { stringValue: "real-log-service" } },
			]),
		},
		scope: { name: "glasshouse.logs.test", version: "1.0" },
	});
	expect(JSON.stringify(result.items)).toContain("scope-retained");
	const rows = await stored(target.id);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		organization_id: organizationId,
		project_id: target.id,
		trace_id: traceId,
		span_id: spanId,
		time_unix_nano: timestamp,
		observed_time_unix_nano: observedTimestamp,
		effective_time_unix_nano: timestamp,
	});
	expect(rows[0]?.ingested_time_unix_nano).toMatch(/^\d+$/);
	expect(JSON.stringify(rows)).toContain(marker);
	for (const table of ["traces", "observations"]) {
		const result = await clickhouse.query({
			query: `SELECT count() AS count FROM ${table} WHERE project_id = {projectId:String}`,
			query_params: { projectId: target.id },
			format: "JSONEachRow",
		});
		expect(Number((await result.json<{ count: string }>())[0]?.count)).toBe(0);
	}
});

for (const transport of ["http", "grpc"] as const) {
	test(`official-schema field 12 event_name persists through real ${transport} ingestion and product readback`, async () => {
		const child = Bun.spawn(
			[
				process.env.OTLP_LOGS_TEST_PYTHON ?? "python3",
				fileURLToPath(
					new URL("../fixtures/otlp-logs-event-name.py", import.meta.url),
				),
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: process.env.PATH, PYTHONNOUSERSITE: "1" },
			},
		);
		const [stdout, , code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(0);
		const { hex } = JSON.parse(stdout) as { hex: string };
		expect(hex).toBe("0a09120712056203657674");
		const target = await project();
		const wire = Buffer.from(hex, "hex");
		if (transport === "http") {
			const response = await request("/v1/logs", {
				method: "POST",
				headers: {
					"content-type": "application/x-protobuf",
					"x-glasshouse-project-id": target.id,
				},
				body: wire,
			});
			expect(response.status).toBe(200);
			expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(0);
		} else {
			expect(await unary(wire, metadata(basic(owner), target.id))).toHaveLength(
				0,
			);
		}
		const rows = await stored(target.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.event_name).toBe("evt");
		const readback = await list(target.id);
		expect(readback.total).toBe(1);
		expect(readback.items[0]).toMatchObject({ event_name: "evt" });
	});

	test(`official SDK ${transport} log exporter writes real correlated logs`, async () => {
		const target = await project();
		const token = await credential(target.id);
		const exported = await sdkExport(
			transport,
			target.id,
			`Bearer ${token.secret}`,
		);
		expect(exported.exported).toBe(true);
		const { items } = await list(target.id);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			project_id: target.id,
			trace_id: exported.traceId,
			span_id: exported.spanId,
			time_unix_nano: timestamp,
			observed_time_unix_nano: observedTimestamp,
			severity_number: 13,
			severity_text: "WARN",
		});
		expect(JSON.stringify(items[0]?.body)).toContain(exported.marker);
		expect(JSON.stringify(items[0]?.resource)).toContain(
			"glasshouse-real-logs-sdk",
		);
		expect(items[0]?.scope.name).toBe("glasshouse.logs.sdk");
		expect(await stored(target.id)).toHaveLength(1);
	}, 25_000);

	test(`official SDK ${transport} rejects anonymous and cross-Project log exports without writes`, async () => {
		const target = await project();
		const other = await project();
		const token = await credential(other.id);
		for (const auth of [null, `Bearer ${token.secret}`]) {
			const exported = await sdkExport(transport, target.id, auth);
			expect(exported.exported).toBe(false);
		}
		expect(await stored(target.id)).toHaveLength(0);
		expect(await stored(other.id)).toHaveLength(0);
	}, 40_000);
}

for (const contentType of ["application/x-protobuf", "application/protobuf"]) {
	test(`HTTP ${contentType} logs return a real protobuf response and preserve nested AnyValue`, async () => {
		const target = await project();
		const marker = `protobuf-${randomUUID()}`;
		const body: AnyValue = {
			arrayValue: {
				values: [
					{ stringValue: marker },
					{ intValue: "9007199254740993" },
					{ bytesValue: "AP+A" },
				],
			},
		};
		const response = await request("/v1/logs", {
			method: "POST",
			headers: {
				"content-type": contentType,
				"x-glasshouse-project-id": target.id,
			},
			body: protobuf(envelope([record(marker, { body })])),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/x-protobuf");
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(bytes).toHaveLength(0);
		expect(
			logProto.ExportLogsServiceResponse.decode(bytes).partialSuccess ?? null,
		).toBeNull();
		expect((await list(target.id)).items[0]?.body).toEqual(body);
	});
}

test("JSON/protobuf empty exports and empty resource/scope envelopes succeed without phantom rows", async () => {
	const target = await project();
	for (const body of [
		{},
		{ resourceLogs: [{}, { scopeLogs: [{ logRecords: [] }] }] },
	]) {
		const response = await ingest(target.id, body);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({});
	}
	const response = await request("/v1/logs", {
		method: "POST",
		headers: {
			"content-type": "application/x-protobuf",
			"x-glasshouse-project-id": target.id,
		},
		body: Buffer.alloc(0),
	});
	expect(response.status).toBe(200);
	expect(new Uint8Array(await response.arrayBuffer())).toHaveLength(0);
	expect(await stored(target.id)).toHaveLength(0);
});

test("uncorrelated logs and observed-time fallback are retained without fabricated trace/span IDs", async () => {
	const target = await project();
	const marker = `uncorrelated-${randomUUID()}`;
	const response = await ingest(
		target.id,
		envelope([
			record(marker, { timeUnixNano: "0" }),
			record("earlier-explicit-time"),
		]),
	);
	expect(response.status).toBe(200);
	const { items } = await list(target.id);
	expect(items).toHaveLength(2);
	expect(items[0]?.time_unix_nano).toBe("0");
	expect(items[0]?.observed_time_unix_nano).toBe(observedTimestamp);
	expect([null, ""]).toContain(items[0]?.trace_id);
	expect([null, ""]).toContain(items[0]?.span_id);
	expect(JSON.stringify(items[0]?.body)).toContain(marker);
});

test("nanosecond ordering and pagination distinguish records one nanosecond apart", async () => {
	const target = await project();
	const times = [
		"1700000000123456789",
		"1700000000123456790",
		"1700000000123456791",
	];
	const response = await ingest(
		target.id,
		envelope(
			times.map((time, index) =>
				record(`nano-${index}`, { timeUnixNano: time }),
			),
		),
	);
	expect(response.status).toBe(200);
	const first = await request(
		`/v1/logs?project_id=${target.id}&limit=2&offset=0`,
	);
	expect(first.status).toBe(200);
	const page = (await first.json()) as { items: LogRow[] };
	expect(page.items.map((item) => item.time_unix_nano)).toEqual(
		[...times].reverse().slice(0, 2),
	);
	const next = await request(
		`/v1/logs?project_id=${target.id}&limit=2&offset=2`,
	);
	expect(next.status).toBe(200);
	const last = (await next.json()) as { items: LogRow[] };
	expect(last.items.map((item) => item.time_unix_nano)).toEqual([times[0]!]);
	expect(
		new Set([...page.items, ...last.items].map((item) => item.log_id)).size,
	).toBe(3);
});

test("trusted Project selection rejects missing, conflicting, foreign, and payload-spoofed provenance atomically", async () => {
	const target = await project();
	const other = await project();
	const marker = `denied-provenance-${randomUUID()}`;
	const valid = envelope([record(marker)]);
	const missing = await jsonPost("/v1/logs", valid);
	expect(missing.status).toBe(404);
	for (const projectId of ["not-a-project", otherDefaultProjectId]) {
		expect((await ingest(projectId, valid)).status).toBe(404);
	}
	const conflict = await jsonPost(`/v1/logs?project_id=${other.id}`, valid, {
		"x-glasshouse-project-id": target.id,
	});
	expect(conflict.status).toBe(404);
	const payload = envelope(
		[record(marker)],
		[{ key: "glasshouse.project.id", value: { stringValue: target.id } }],
	);
	payload.resourceLogs.push(
		...envelope(
			[record(marker)],
			[
				{
					key: "glasshouse.project.id",
					value: { stringValue: otherDefaultProjectId },
				},
			],
		).resourceLogs,
	);
	expect((await ingest(target.id, payload)).status).toBe(404);
	const foreign = await ingest(target.id, valid, {
		authorization: basic(outsider),
	});
	expect(foreign.status).toBe(404);
	const unknown = await ingest(randomUUID(), valid);
	expect(unknown.status).toBe(404);
	expect(await foreign.text()).toBe(await unknown.text());
	for (const projectId of [target.id, other.id, otherDefaultProjectId])
		expect(await stored(projectId)).toHaveLength(0);
	const accepted = await ingest(target.id, valid);
	expect(accepted.status).toBe(200);
	expect((await stored(target.id))[0]).toMatchObject({
		organization_id: organizationId,
	});
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
	test(`logs reject ${variant} Project selectors before redaction or storage`, async () => {
		const target = await project();
		const value: Record<string, unknown> = { stringValue: target.id };
		const selector: Record<string, unknown> = {
			key: "glasshouse.project.id",
			value,
		};
		if (variant.startsWith("attribute-extension")) selector.future = null;
		if (variant.startsWith("value-extension"))
			value.future = { secret: syntheticSecret };
		if (variant === "null-extension") value.future = null;
		if (variant === "conflicting-values") value.boolValue = true;
		if (variant === "malformed-id") value.stringValue = "invalid";
		const selectors = [selector];
		if (variant.endsWith("switch") || variant === "duplicate-identical")
			selectors.push({
				key: "glasshouse.project.id",
				value: {
					stringValue:
						variant === "duplicate-identical"
							? target.id
							: otherDefaultProjectId,
				},
			});
		const payload = envelope([record(syntheticSecret)]);
		Object.assign(payload.resourceLogs[0]!.resource, { attributes: selectors });
		expect(
			(await ingest(target.id, payload, { authorization: "" })).status,
		).toBe(401);
		const rejected = await ingest(target.id, payload);
		expect(rejected.status).toBe(400);
		expect(await rejected.text()).not.toContain(syntheticSecret);
		if (variant === "duplicate-identical" || variant === "malformed-id") {
			const bytes = protobuf(payload);
			expect(
				(
					await request("/v1/logs", {
						method: "POST",
						headers: {
							"content-type": "application/x-protobuf",
							"x-glasshouse-project-id": target.id,
						},
						body: bytes,
					})
				).status,
			).toBe(400);
			await expect(
				unary(bytes, metadata(basic(owner), target.id)),
			).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
		}
		expect(await stored(target.id)).toHaveLength(0);
		expect(await stored(otherDefaultProjectId)).toHaveLength(0);
	});
}

test("log ingestion checks every repeated query Project selector against the trusted header", async () => {
	const target = await project();
	for (const key of ["project_id", "filter[project_id]"]) {
		const response = await jsonPost(
			`/v1/logs?${key}=${target.id}&${key}=${otherDefaultProjectId}`,
			envelope([record("query-conflict")]),
			{ "x-glasshouse-project-id": target.id },
		);
		expect(response.status).toBe(404);
	}
	expect(await stored(target.id)).toHaveLength(0);
});

test("public physical-duplicate pagination is bounded and reauthorizes every Project-scoped cursor read", async () => {
	const target = await project();
	const other = await project();
	expect(
		(
			await ingest(
				target.id,
				envelope([record("private-duplicate-pagination")]),
			)
		).status,
	).toBe(200);
	await clickhouse.command({
		query:
			"INSERT INTO logs SELECT * FROM logs WHERE organization_id = {organizationId:String} AND project_id = {projectId:String}",
		query_params: { organizationId, projectId: target.id },
		clickhouse_settings: { insert_deduplicate: 0 },
	});
	const first = await request(`/v1/logs?project_id=${target.id}&limit=1`);
	expect(first.status).toBe(200);
	const page = (await first.json()) as {
		items: LogRow[];
		total: number;
		next_cursor: string;
	};
	expect(page.total).toBe(2);
	expect(page.items).toHaveLength(1);
	expect(page.next_cursor).toBeDefined();
	const cursor = encodeURIComponent(page.next_cursor);
	const issued = await credential(target.id);
	for (const [projectId, suffix, headers, status] of [
		[other.id, "", {}, 400],
		[target.id, "&filter[severity_text]=ERROR", {}, 400],
		[target.id, "", { authorization: basic(outsider) }, 404],
		[target.id, "", { authorization: `Bearer ${issued.secret}` }, 401],
	] as const) {
		const denied = await request(
			`/v1/logs?project_id=${projectId}&limit=1&cursor=${cursor}${suffix}`,
			{ headers },
		);
		expect(denied.status).toBe(status);
		expect(await denied.text()).not.toContain("private-duplicate-pagination");
	}
	await clickhouse.command({ query: "OPTIMIZE TABLE logs FINAL" });
	const next = await request(
		`/v1/logs?project_id=${target.id}&limit=1&cursor=${cursor}`,
	);
	expect(next.status).toBe(200);
	const last = (await next.json()) as {
		items: LogRow[];
		total: number;
		next_cursor?: string;
	};
	expect(last.total).toBe(2);
	expect(last.items).toEqual(page.items);
	expect(last.next_cursor).toBeUndefined();
	expect(JSON.stringify(last)).not.toContain("row_block_");
});

test("log reads require current Organization authority and cannot be used by ingestion bearer credentials", async () => {
	const target = await project();
	const token = await credential(target.id);
	expect(
		(await ingest(target.id, envelope([record("private-log")]))).status,
	).toBe(200);
	for (const auth of ["", `Bearer ${token.secret}`]) {
		const response = await request(`/v1/logs?project_id=${target.id}`, {
			headers: { authorization: auth },
		});
		expect(response.status).toBe(401);
		expect(await response.text()).not.toContain("private-log");
	}
	const foreign = await request(`/v1/logs?project_id=${target.id}`, {
		headers: { authorization: basic(outsider) },
	});
	expect(foreign.status).toBe(404);
	expect(await foreign.text()).not.toContain("private-log");
	const reader = await localAccount("read_only");
	expect((await list(target.id, reader.headers)).items).toHaveLength(1);
	const denied = await ingest(
		target.id,
		envelope([record("denied-read-only")]),
		reader.headers,
	);
	expect(denied.status).toBe(404);
	expect(await stored(target.id)).toHaveLength(1);
}, 20_000);

test("log reads reject every conflicting repeated Project selector without leaking either Project", async () => {
	const target = await project();
	const other = await project();
	const marker = `selector-private-${randomUUID()}`;
	expect((await ingest(target.id, envelope([record(marker)]))).status).toBe(
		200,
	);
	for (const [suffix, status] of [
		[`&project_id=${other.id}`, 400],
		[`&project_id=${otherDefaultProjectId}`, 400],
		["&project_id=not-a-project", 400],
		[`&filter[project_id]=${target.id}&filter[project_id]=${other.id}`, 404],
		[
			`&filter[project_id]=${target.id}&filter[project_id]=${otherDefaultProjectId}`,
			404,
		],
	] as const) {
		const denied = await request(`/v1/logs?project_id=${target.id}${suffix}`);
		expect(denied.status).toBe(status);
		expect(await denied.text()).not.toContain(marker);
	}
	expect((await list(target.id)).items).toHaveLength(1);
	expect(await stored(other.id)).toHaveLength(0);
});

test("rotation and revocation stop future HTTP and gRPC writes with the old bearer secret", async () => {
	const target = await project();
	const issued = await credential(target.id);
	const initial = envelope([record("before-rotation")]);
	const accepted = await ingest(target.id, initial, {
		authorization: `Bearer ${issued.secret}`,
	});
	expect(accepted.status).toBe(200);
	const rotated = await jsonPost(
		`/v1/admin/otlp-credentials/${issued.credential.id}/rotate?project_id=${target.id}`,
		{},
	);
	expect(rotated.status).toBe(200);
	const replacement = (await rotated.json()) as { secret: string };
	const body = envelope([record("denied-revoked")]);
	const oldSecret = await ingest(target.id, body, {
		authorization: `Bearer ${issued.secret}`,
	});
	expect(oldSecret.status).toBe(401);
	await expect(
		unary(protobuf(body), metadata(`Bearer ${issued.secret}`, target.id)),
	).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
	const newSecret = await ingest(
		target.id,
		envelope([record("after-rotation")]),
		{ authorization: `Bearer ${replacement.secret}` },
	);
	expect(newSecret.status).toBe(200);
	const revoked = await jsonPost(
		`/v1/admin/otlp-credentials/${issued.credential.id}/revoke?project_id=${target.id}`,
		{},
	);
	expect(revoked.status).toBe(200);
	const revokedSecret = await ingest(target.id, body, {
		authorization: `Bearer ${replacement.secret}`,
	});
	expect(revokedSecret.status).toBe(401);
	await expect(
		unary(protobuf(body), metadata(`Bearer ${replacement.secret}`, target.id)),
	).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
	expect(await stored(target.id)).toHaveLength(2);
});

test("a revocation that wins the PostgreSQL credential fence prevents an already-started log write", async () => {
	const target = await project();
	const issued = await credential(target.id);
	const auth = { authorization: `Bearer ${issued.secret}` };
	const admitted = await ingest(
		target.id,
		envelope([record("before-revocation-fence")]),
		auth,
	);
	expect(admitted.status).toBe(200);
	const revoker = await pool.connect();
	let open = false;
	let pending: Promise<Response> | undefined;
	try {
		await revoker.query("BEGIN");
		open = true;
		await revoker.query(
			"UPDATE project_otlp_credentials SET revoked_at = clock_timestamp() WHERE id = $1",
			[issued.credential.id],
		);
		pending = ingest(
			target.id,
			envelope([record("must-not-cross-revocation-fence")]),
			auth,
		);
		let waiting = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			const result = await pool.query<{ waiting: boolean }>(
				`SELECT EXISTS (
					SELECT 1 FROM pg_stat_activity
					WHERE datname = current_database() AND pid <> pg_backend_pid()
					AND wait_event_type = 'Lock' AND query LIKE '%project_otlp_credentials%'
				) AS waiting`,
			);
			if (result.rows[0]?.waiting) {
				waiting = true;
				break;
			}
			await Bun.sleep(20);
		}
		expect(
			waiting,
			"the real public request must wait on the credential fence",
		).toBe(true);
		await revoker.query("COMMIT");
		open = false;
		expect((await pending).status).toBe(401);
		expect(await stored(target.id)).toHaveLength(1);
		expect(JSON.stringify(await stored(target.id))).not.toContain(
			"must-not-cross-revocation-fence",
		);
	} finally {
		if (open) await revoker.query("ROLLBACK");
		revoker.release();
		await pending?.catch(() => undefined);
	}
}, 20_000);

test("creator demotion and disablement invalidate an unrevoked log credential and cookie sessions", async () => {
	const target = await project();
	const creator = await localAccount("admin");
	const issued = await credential(target.id, creator.headers);
	const auth = { authorization: `Bearer ${issued.secret}` };
	const admitted = await ingest(
		target.id,
		envelope([record("authorized-creator")]),
		auth,
	);
	expect(admitted.status).toBe(200);
	const demote = await request(`/v1/admin/actors/${creator.actorId}/role`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ role: "read_only" }),
	});
	expect(demote.status).toBe(200);
	const demoted = await ingest(
		target.id,
		envelope([record("denied-demoted")]),
		auth,
	);
	expect(demoted.status).toBe(404);
	await expect(
		unary(
			protobuf(envelope([record("denied-demoted-grpc")])),
			metadata(auth.authorization, target.id),
		),
	).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
	const disable = await request(
		`/v1/admin/local-accounts/${creator.actorId}/status`,
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: false }),
		},
	);
	expect(disable.status).toBe(200);
	const disabled = await ingest(
		target.id,
		envelope([record("denied-disabled")]),
		auth,
	);
	expect(disabled.status).toBe(401);
	const read = await request(`/v1/logs?project_id=${target.id}`, {
		headers: creator.headers,
	});
	expect(read.status).toBe(401);
	expect(await stored(target.id)).toHaveLength(1);
}, 20_000);

test("cookie precedence and CSRF also protect the raw logs ingestion route", async () => {
	const target = await project();
	const user = await localAccount("user");
	const body = envelope([record("cookie-authorized")]);
	const missingCsrf = await ingest(target.id, body, {
		cookie: user.headers.cookie,
	});
	expect(missingCsrf.status).toBe(403);
	const crossOrigin = await ingest(target.id, body, {
		...user.headers,
		origin: "https://attacker.invalid",
	});
	expect(crossOrigin.status).toBe(403);
	const invalidCookie = await ingest(target.id, body, {
		cookie: "glasshouse_session=invalid",
	});
	expect(invalidCookie.status).toBe(401);
	expect(await stored(target.id)).toHaveLength(0);
	expect((await ingest(target.id, body, user.headers)).status).toBe(200);
	expect(await stored(target.id)).toHaveLength(1);
}, 20_000);

for (const state of ["archived", "deleting"] as const) {
	test(`${state} Projects reject HTTP/gRPC logs without retaining rows`, async () => {
		const target = await project();
		const issued = await credential(target.id);
		if (state === "archived") {
			const archived = await jsonPost(`/v1/projects/${target.id}/archive`, {});
			expect(archived.status).toBe(200);
		} else {
			await pool.query(
				"UPDATE projects SET status = 'deleting' WHERE id = $1",
				[target.id],
			);
		}
		try {
			const body = envelope([record(`denied-${state}`)]);
			const denied = await ingest(target.id, body, {
				authorization: `Bearer ${issued.secret}`,
			});
			expect(denied.status).toBe(404);
			await expect(
				unary(protobuf(body), metadata(`Bearer ${issued.secret}`, target.id)),
			).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
			expect(await stored(target.id)).toHaveLength(0);
		} finally {
			// A deleting Project freezes organization mutations; release scenario state.
			if (state === "deleting")
				await pool.query(
					"UPDATE projects SET status = 'active' WHERE id = $1",
					[target.id],
				);
		}
	});
}

test("configured key redaction traverses body/resource/scope/record AnyValue before physical storage", async () => {
	const target = await project();
	const nested: AnyValue = {
		arrayValue: {
			values: [
				{
					kvlistValue: {
						values: [
							{ key: "secret", value: { stringValue: syntheticSecret } },
							{ key: "safe", value: { stringValue: "safe-nested-value" } },
						],
					},
				},
			],
		},
	};
	const attrs = [{ key: "nested", value: nested }];
	const response = await ingest(
		target.id,
		envelope(
			[record("redaction", { body: nested, attributes: attrs })],
			attrs,
			attrs,
		),
	);
	expect(response.status).toBe(200);
	for (const rows of [(await list(target.id)).items, await stored(target.id)]) {
		const retained = JSON.stringify(rows);
		expect(retained).not.toContain(syntheticSecret);
		expect(retained).toContain("safe-nested-value");
	}
});

test("unknown deep AnyValue extensions cannot smuggle body or attribute secrets into storage", async () => {
	const target = await project();
	const body = JSON.stringify(
		envelope([
			record("deep-unknown", {
				body: {
					stringValue: "drop-uninspectable-body",
					futureExtension: "DEEP_BODY",
				} as AnyValue,
				attributes: [
					{
						key: "unknown",
						value: {
							stringValue: "drop-uninspectable-attribute",
							futureExtension: "DEEP_ATTRIBUTE",
						} as AnyValue,
					},
				],
			}),
		]),
	).replaceAll(
		/"DEEP_(?:BODY|ATTRIBUTE)"/g,
		'{"values":['.repeat(20_000) +
			JSON.stringify({ secret: syntheticSecret }) +
			"]}".repeat(20_000),
	);
	expect(Buffer.byteLength(body)).toBeLessThan(bodyLimit);
	const response = await request("/v1/logs", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-glasshouse-project-id": target.id,
		},
		body,
	});
	expect(response.status).toBe(200);
	for (const rows of [(await list(target.id)).items, await stored(target.id)]) {
		expect(rows).toHaveLength(1);
		const retained = JSON.stringify(rows);
		expect(retained).not.toContain(syntheticSecret);
		expect(retained).not.toContain("drop-uninspectable-body");
		expect(retained).not.toContain("drop-uninspectable-attribute");
	}
});

test("approved all_text policy redacts log bodies while deployment key redaction remains a floor", async () => {
	const target = await project();
	await policy(target.id, { mode: "all_text", keys: ["policy.secret"] });
	const response = await ingest(
		target.id,
		envelope([
			record("governed", {
				body: {
					kvlistValue: {
						values: [
							{ key: "message", value: { stringValue: syntheticSecret } },
						],
					},
				},
				attributes: [
					{ key: "secret", value: { stringValue: "deployment-secret-marker" } },
					{
						key: "policy.secret",
						value: { stringValue: "policy-secret-marker" },
					},
				],
			}),
		]),
	);
	expect(response.status).toBe(200);
	for (const rows of [(await list(target.id)).items, await stored(target.id)]) {
		const retained = JSON.stringify(rows);
		for (const secret of [
			syntheticSecret,
			"deployment-secret-marker",
			"policy-secret-marker",
		])
			expect(retained).not.toContain(secret);
		expect(retained).toContain("[REDACTED]");
	}
});

test("deployment body redaction covers scalar and nested AnyValue bodies even under a none policy", async () => {
	const target = await project();
	process.env.GLASSHOUSE_REDACT_INPUT = "true";
	try {
		const response = await ingest(
			target.id,
			envelope([
				record("scalar-body", { body: { stringValue: syntheticSecret } }),
				record("nested-body", {
					body: { arrayValue: { values: [{ stringValue: syntheticSecret }] } },
				}),
			]),
		);
		expect(response.status).toBe(200);
		for (const rows of [
			(await list(target.id)).items,
			await stored(target.id),
		]) {
			expect(rows).toHaveLength(2);
			expect(JSON.stringify(rows)).not.toContain(syntheticSecret);
			expect(JSON.stringify(rows)).toContain("[REDACTED]");
		}
	} finally {
		process.env.GLASSHOUSE_REDACT_INPUT = "false";
	}
});

test("the retained-record byte ceiling rejects an entire export and applies only after redaction", async () => {
	const target = await project();
	const oversized = envelope([
		record("must-not-partially-retain"),
		record("oversized-record", { body: { stringValue: "界".repeat(22_000) } }),
	]);
	const denied = await ingest(target.id, oversized);
	expect(denied.status).toBe(413);
	await expect(
		unary(protobuf(oversized), metadata(basic(owner), target.id)),
	).rejects.toMatchObject({ code: grpc.status.RESOURCE_EXHAUSTED });
	expect(await stored(target.id)).toHaveLength(0);
	await policy(target.id, { mode: "all_text", keys: [] });
	expect((await ingest(target.id, oversized)).status).toBe(200);
	const rows = await stored(target.id);
	expect(rows).toHaveLength(2);
	for (const row of rows) {
		expect(JSON.parse(row.body as string)).toEqual({
			stringValue: "[REDACTED]",
		});
	}
}, 20_000);

test("identical byte retries deduplicate logs without collapsing distinct records or tenant scopes", async () => {
	const first = await project();
	const second = await project();
	const body = JSON.stringify(
		envelope([record("retry-body"), record("retry-body")]),
	);
	for (const [projectId, compressed] of [
		[first.id, false],
		[first.id, true],
		[second.id, false],
	] as const) {
		const response = await request("/v1/logs", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-glasshouse-project-id": projectId,
				...(compressed ? { "content-encoding": "gzip" } : {}),
			},
			body: compressed ? gzipSync(body) : body,
		});
		expect(response.status).toBe(200);
	}
	expect(await stored(first.id)).toHaveLength(2);
	expect(await stored(second.id)).toHaveLength(2);
});

for (const [name, invalid] of [
	["non-integer timestamp", { timeUnixNano: "1700000000.5" }],
	["negative timestamp", { timeUnixNano: "-1" }],
	["uint64 overflow", { timeUnixNano: "18446744073709551616" }],
	["malformed trace id", { traceId: "not-hex" }],
	["malformed span id", { spanId: "123" }],
	["invalid severity", { severityNumber: 25 }],
	[
		"ambiguous AnyValue oneof",
		{ body: { stringValue: "ambiguous", boolValue: true } },
	],
	[
		"wrong nested AnyValue type",
		{ body: { arrayValue: { values: [{ boolValue: "true" }] } } },
	],
] as const) {
	test(`invalid log ${name} rejects the entire export before persistence`, async () => {
		const target = await project();
		const body = envelope([
			record("must-not-partially-write"),
			{ ...record("invalid-record"), ...invalid } as LogRecord,
		]);
		const response = await ingest(target.id, body);
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain("invalid-record");
		expect(await stored(target.id)).toHaveLength(0);
	});
}

test("ProtoJSON nulls normalize as unset but null repeated elements are rejected", async () => {
	const target = await project();
	const valid = {
		resourceLogs: [
			{
				resource: null,
				scopeLogs: [
					{
						scope: null,
						logRecords: [{ ...record("null-normalized"), attributes: null }],
					},
				],
			},
		],
	};
	expect((await ingest(target.id, valid)).status).toBe(200);
	const invalid = { resourceLogs: [{ scopeLogs: [{ logRecords: [null] }] }] };
	expect((await ingest(target.id, invalid)).status).toBe(400);
	expect(await stored(target.id)).toHaveLength(1);
});

test("malformed JSON, protobuf, and gzip return bounded protocol errors and leave storage empty", async () => {
	const target = await project();
	for (const [contentType, body, encoding] of [
		["application/json", `{"secret":"${syntheticSecret}"`, "identity"],
		["application/x-protobuf", Buffer.from([255]), "identity"],
		["application/json", "not-gzip", "gzip"],
	] as const) {
		const response = await request("/v1/logs", {
			method: "POST",
			headers: {
				"content-type": contentType,
				"content-encoding": encoding,
				"x-glasshouse-project-id": target.id,
			},
			body,
		});
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain(contentType);
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(bytes.byteLength).toBeLessThan(1024);
		expect(new TextDecoder().decode(bytes)).not.toContain(syntheticSecret);
		if (contentType === "application/x-protobuf") expect(bytes[0]).toBe(18); // google.rpc.Status.message, not a JSON envelope.
	}
	await expect(
		unary(Buffer.from([255]), metadata(basic(owner), target.id)),
	).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
	expect(await stored(target.id)).toHaveLength(0);
});

test("compressed and uncompressed log exports cannot exceed HTTP or gRPC body budgets", async () => {
	const target = await project();
	const body = JSON.stringify(
		envelope([
			record("oversize", { body: { stringValue: "x".repeat(bodyLimit) } }),
		]),
	);
	for (const compressed of [false, true]) {
		const response = await request("/v1/logs", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-glasshouse-project-id": target.id,
				...(compressed ? { "content-encoding": "gzip" } : {}),
			},
			body: compressed ? gzipSync(body) : body,
		});
		expect(response.status).toBe(413);
	}
	await expect(
		unary(Buffer.alloc(bodyLimit + 1), metadata(basic(owner), target.id)),
	).rejects.toMatchObject({ code: grpc.status.RESOURCE_EXHAUSTED });
	expect(await stored(target.id)).toHaveLength(0);
});

test("known AnyValue depth and per-scope record/attribute limits fail closed before any write", async () => {
	const target = await project();
	let nested: AnyValue = { stringValue: syntheticSecret };
	for (let index = 0; index < 40; index++)
		nested = { arrayValue: { values: [nested] } };
	for (const body of [
		envelope([record("depth", { body: nested })]),
		envelope(Array.from({ length: 513 }, () => record("too-many-records"))),
		envelope([
			record("attributes", {
				attributes: Array.from({ length: 129 }, (_, index) => ({
					key: `attribute-${index}`,
					value: { stringValue: "safe" },
				})),
			}),
		]),
	]) {
		expect((await ingest(target.id, body)).status).toBe(400);
	}
	expect(await stored(target.id)).toHaveLength(0);
	const healthy = await ingest(target.id, envelope([record("still-healthy")]));
	expect(healthy.status).toBe(200);
});

test("unsupported media and encoding fail explicitly instead of acknowledging dropped logs", async () => {
	const target = await project();
	for (const headers of [
		{ "content-type": "text/plain" },
		{ "content-type": "application/json", "content-encoding": "br" },
	]) {
		const response = await request("/v1/logs", {
			method: "POST",
			headers: { "x-glasshouse-project-id": target.id, ...headers },
			body: "{}",
		});
		expect(response.status).toBe(415);
	}
	expect(await stored(target.id)).toHaveLength(0);
});

test("gRPC LogsService health and metadata enforce the same exact secure routing contract", async () => {
	const target = await project();
	const service = Buffer.from(
		"opentelemetry.proto.collector.logs.v1.LogsService",
	);
	expect(
		await unary(
			Buffer.concat([Buffer.from([10, service.length]), service]),
			new grpc.Metadata(),
			"/grpc.health.v1.Health/Check",
		),
	).toEqual(Buffer.from([8, 1]));
	const body = protobuf(envelope([record("denied-metadata")]));
	// Repeated authorization entries fail locally in HTTP/2; send the joined
	// wire representation so the real server must reject ambiguous metadata.
	for (const headers of [
		metadata(null, target.id),
		metadata(basic(owner), null),
		metadata(`${basic(owner)}, ${basic(outsider)}`, target.id),
		metadata(`${basic(outsider)}, ${basic(owner)}`, target.id),
		metadata(basic(owner), `${target.id}, ${otherDefaultProjectId}`),
		metadata(basic(owner), `${otherDefaultProjectId}, ${target.id}`),
	]) {
		await expect(unary(body, headers)).rejects.toMatchObject({
			code: grpc.status.UNAUTHENTICATED,
			details: "Authentication required",
		});
	}
	await expect(
		unary(body, metadata(basic(outsider), target.id)),
	).rejects.toMatchObject({ code: grpc.status.PERMISSION_DENIED });
	await expect(
		unary(
			Buffer.alloc(0),
			metadata(basic(owner), target.id),
			"/opentelemetry.proto.collector.unknown.v1.UnknownService/Export",
		),
	).rejects.toMatchObject({ code: grpc.status.UNIMPLEMENTED });
	const metricsPath =
		"/opentelemetry.proto.collector.metrics.v1.MetricsService/Export";
	expect(
		await unary(
			Buffer.alloc(0),
			metadata(basic(owner), target.id),
			metricsPath,
		),
	).toEqual(Buffer.alloc(0));
	await expect(
		unary(Buffer.alloc(0), metadata(null, target.id), metricsPath),
	).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
	expect(await stored(target.id)).toHaveLength(0);
	expect(await stored(otherDefaultProjectId)).toHaveLength(0);
});

test("OTLP bearer credentials remain method/path exact after logs ingestion is enabled", async () => {
	const target = await project();
	const issued = await credential(target.id);
	const headers = { authorization: `Bearer ${issued.secret}` };
	for (const [method, path] of [
		["GET", `/v1/logs?project_id=${target.id}`],
		["HEAD", `/v1/logs?project_id=${target.id}`],
		["PUT", `/v1/logs?project_id=${target.id}`],
		["GET", `/v1/logs/events?project_id=${target.id}`],
		["POST", `/v1/logs/events?project_id=${target.id}`],
		["POST", `/v1/otel/v1/logs?project_id=${target.id}`],
		["GET", `/v1/admin/otlp-credentials?project_id=${target.id}`],
	]) {
		expect((await request(path, { method, headers })).status).toBe(401);
	}
	const accepted = await ingest(
		target.id,
		envelope([record("exact-path")]),
		headers,
	);
	expect(accepted.status).toBe(200);
	expect(await stored(target.id)).toHaveLength(1);
});

test("real ClickHouse write failures return sanitized protocol failures instead of success", async () => {
	const target = await project();
	const healthy = await ingest(
		target.id,
		envelope([record("before-storage-failure")]),
	);
	expect(healthy.status).toBe(200);
	await clickhouse.command({
		query: "RENAME TABLE logs TO logs_temporarily_unavailable",
	});
	try {
		const body = envelope([record(syntheticSecret)]);
		const failed = await ingest(target.id, body);
		expect(failed.status).toBe(500);
		const text = await failed.text();
		expect(text.length).toBeLessThan(1024);
		for (const internal of [
			syntheticSecret,
			database,
			"logs_temporarily_unavailable",
			"DB::Exception",
		])
			expect(text).not.toContain(internal);
		await expect(
			unary(protobuf(body), metadata(basic(owner), target.id)),
		).rejects.toMatchObject({ code: grpc.status.INTERNAL });
	} finally {
		await clickhouse.command({
			query: "RENAME TABLE logs_temporarily_unavailable TO logs",
		});
	}
	expect(await stored(target.id)).toHaveLength(1);
	const recovered = await ingest(
		target.id,
		envelope([record("after-storage-recovery")]),
	);
	expect(recovered.status).toBe(200);
});

test("governance previews count logs and retention deletes only a bounded expired Project batch", async () => {
	const target = await project();
	const untouched = await project();
	const policyId = await policy(target.id, { mode: "none", keys: [] });
	const old = envelope([record("expired-1"), record("expired-2")]);
	expect((await ingest(target.id, old)).status).toBe(200);
	expect((await ingest(untouched.id, old)).status).toBe(200);
	const recent = record("recent-survives", {
		timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
	});
	expect((await ingest(target.id, envelope([recent]))).status).toBe(200);
	const preview = await jsonPost("/v1/governance/retention/preview", {
		project_id: target.id,
	});
	expect(preview.status).toBe(200);
	const planned = (await preview.json()) as {
		preview_id: string;
		counts: Record<string, number>;
	};
	expect(planned.counts.logs).toBe(2);
	const input = {
		project_id: target.id,
		policy_version_id: policyId,
		preview_id: planned.preview_id,
		batch_size: 1,
	};
	const run = await jsonPost("/v1/governance/retention/runs", input);
	expect(run.status).toBe(200);
	const completed = (await run.json()) as { run_id: string };
	expect(completed).toMatchObject({
		status: "completed",
		counts: { logs: 1 },
	});
	const persisted = await pool.query(
		"SELECT status, counts, cursor, lease_expires_at FROM governance_retention_runs WHERE id = $1 AND project_id = $2",
		[completed.run_id, target.id],
	);
	expect(persisted.rows).toEqual([
		{
			status: "completed",
			counts: { logs: 1 },
			cursor: { stage: "completed", counts: { logs: 1 } },
			lease_expires_at: null,
		},
	]);
	const retained = await stored(target.id);
	expect(retained).toHaveLength(2);
	expect(JSON.stringify(retained)).toContain("recent-survives");
	expect(await stored(untouched.id)).toHaveLength(2);
	const replay = await jsonPost("/v1/governance/retention/runs", input);
	expect(replay.status).toBe(409);
	expect(await stored(target.id)).toHaveLength(2);
	const evidence = await pool.query(
		"SELECT event_type FROM governance_audit_events WHERE project_id = $1 AND event_type IN ('retention_started', 'retention_completed', 'retention_failed') ORDER BY event_type",
		[target.id],
	);
	expect(evidence.rows).toEqual([
		{ event_type: "retention_completed" },
		{ event_type: "retention_started" },
	]);
}, 30_000);

test("log retention counts duplicate physical rows against its batch ceiling", async () => {
	const target = await project();
	const policyId = await policy(target.id, { mode: "none", keys: [] });
	const ingested = await ingest(
		target.id,
		envelope([record("expired-duplicate-1"), record("expired-duplicate-2")]),
	);
	expect(ingested.status).toBe(200);
	await clickhouse.command({
		query:
			"INSERT INTO logs SELECT * FROM logs WHERE organization_id = {organizationId:String} AND project_id = {projectId:String}",
		query_params: { organizationId, projectId: target.id },
		clickhouse_settings: { insert_deduplicate: 0 },
	});
	const rows = await stored(target.id);
	expect(rows).toHaveLength(4);
	expect(new Set(rows.map((row) => row.log_id)).size).toBe(2);
	let remaining = rows.length;
	for (const [batchSize, expectedDeleted] of [
		[1, 1],
		[3, 3],
		[2, 0],
	] as const) {
		const preview = await jsonPost("/v1/governance/retention/preview", {
			project_id: target.id,
		});
		expect(preview.status).toBe(200);
		const planned = (await preview.json()) as {
			preview_id: string;
			counts: { logs: number };
		};
		expect(planned.counts.logs).toBe(remaining);
		const input = {
			project_id: target.id,
			policy_version_id: policyId,
			preview_id: planned.preview_id,
			batch_size: batchSize,
		};
		const run = await jsonPost("/v1/governance/retention/runs", input);
		expect(run.status).toBe(200);
		expect(await run.json()).toMatchObject({
			status: "completed",
			counts: { logs: expectedDeleted },
		});
		remaining -= expectedDeleted;
		expect(await stored(target.id)).toHaveLength(remaining);
		expect(
			(await jsonPost("/v1/governance/retention/runs", input)).status,
		).toBe(409);
		expect(await stored(target.id)).toHaveLength(remaining);
	}
}, 30_000);

test("log retention makes honest bounded progress through a duplicate group above 500", async () => {
	const target = await project();
	const survivor = await project();
	const policyId = await policy(target.id, { mode: "none", keys: [] });
	const expired = envelope([record("oversized-duplicate-group")]);
	for (const projectId of [target.id, survivor.id])
		expect((await ingest(projectId, expired)).status).toBe(200);
	await clickhouse.command({
		query:
			"INSERT INTO logs SELECT logs.* FROM logs CROSS JOIN numbers(500) AS copies WHERE organization_id = {organizationId:String} AND project_id = {projectId:String}",
		query_params: { organizationId, projectId: target.id },
		clickhouse_settings: { insert_deduplicate: 0 },
	});
	const recent = record("recent-survives-large-duplicate-group", {
		timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
	});
	expect((await ingest(target.id, envelope([recent]))).status).toBe(200);
	expect(await stored(target.id)).toHaveLength(502);
	for (const [remaining, expectedDeleted] of [
		[501, 500],
		[1, 1],
		[0, 0],
	] as const) {
		const preview = await jsonPost("/v1/governance/retention/preview", {
			project_id: target.id,
		});
		expect(preview.status).toBe(200);
		const planned = (await preview.json()) as {
			preview_id: string;
			counts: { logs: number };
		};
		expect(planned.counts.logs).toBe(remaining);
		const run = await jsonPost("/v1/governance/retention/runs", {
			project_id: target.id,
			policy_version_id: policyId,
			preview_id: planned.preview_id,
			batch_size: 500,
		});
		expect(run.status).toBe(200);
		const completed = (await run.json()) as { run_id: string };
		expect(completed).toMatchObject({
			status: "completed",
			counts: { logs: expectedDeleted },
		});
		const evidence = await pool.query(
			"SELECT status, counts FROM governance_retention_runs WHERE id = $1",
			[completed.run_id],
		);
		expect(evidence.rows[0]).toEqual({
			status: "completed",
			counts: { logs: expectedDeleted },
		});
		expect(await stored(target.id)).toHaveLength(
			remaining - expectedDeleted + 1,
		);
		expect(JSON.stringify(await stored(target.id))).toContain(
			"recent-survives-large-duplicate-group",
		);
		expect(await stored(survivor.id)).toHaveLength(1);
	}
}, 30_000);

test("permanent Project deletion removes physical logs without touching another Project or tenant", async () => {
	const target = await project();
	const survivor = await project();
	const body = envelope([record("deletion-marker")]);
	for (const projectId of [target.id, survivor.id])
		expect((await ingest(projectId, body)).status).toBe(200);
	const foreign = await ingest(otherDefaultProjectId, body, {
		authorization: basic(outsider),
	});
	expect(foreign.status).toBe(200);
	const token = await credential(target.id);
	const deleted = await request(`/v1/projects/${target.id}`, {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ confirmation_name: target.name }),
	});
	expect(deleted.status).toBe(204);
	expect(await stored(target.id)).toHaveLength(0);
	expect(await stored(survivor.id)).toHaveLength(1);
	expect(await stored(otherDefaultProjectId)).toHaveLength(1);
	const status = await pool.query(
		"SELECT status FROM project_deletion_jobs WHERE project_id = $1",
		[target.id],
	);
	expect(status.rows[0]?.status).toBe("completed");
	expect((await request(`/v1/logs?project_id=${target.id}`)).status).toBe(404);
	const denied = await ingest(target.id, body, {
		authorization: `Bearer ${token.secret}`,
	});
	expect([401, 404]).toContain(denied.status);
}, 30_000);

test("Project deletion retries remove logs even after older ClickHouse cleanup checkpoints", async () => {
	const target = await project();
	const survivor = await project();
	const body = envelope([record("checkpointed-deletion")]);
	for (const projectId of [target.id, survivor.id])
		expect((await ingest(projectId, body)).status).toBe(200);
	await pool.query(
		`WITH deleting AS (
			UPDATE projects SET status = 'deleting' WHERE id = $1 RETURNING id
		) INSERT INTO project_deletion_jobs (
			organization_id, project_id, requested_by, status,
			traces_cleaned_at, observations_cleaned_at, attempt_count
		) SELECT $2::uuid, id, $3, 'clickhouse_cleaned', now(), now(), 1 FROM deleting`,
		[target.id, organizationId, owner.username],
	);
	try {
		const deleted = await request(`/v1/projects/${target.id}`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ confirmation_name: target.name }),
		});
		expect(deleted.status).toBe(204);
		expect(await stored(target.id)).toHaveLength(0);
		expect(await stored(survivor.id)).toHaveLength(1);
		const status = await pool.query(
			"SELECT status, attempt_count FROM project_deletion_jobs WHERE project_id = $1",
			[target.id],
		);
		expect(status.rows[0]).toMatchObject({
			status: "completed",
			attempt_count: 2,
		});
	} finally {
		await pool.query("UPDATE projects SET status = 'active' WHERE id = $1", [
			target.id,
		]);
	}
}, 30_000);
