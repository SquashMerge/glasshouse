import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { type ClickHouseClient, createClient } from "@clickhouse/client";
import * as grpc from "@grpc/grpc-js";
import { Pool } from "pg";
import { bootstrapAuthorization } from "../../src/db/bootstrap-authorization.js";
import * as clickhouseModule from "../../src/db/clickhouse.js";
import { applyClickHouseMigrations } from "../../src/db/clickhouse-migrate.js";
import { LocalCredentialStore } from "../../src/db/local-credentials.js";
import { migrate } from "../../src/db/migrate.js";
import {
	createOtlpCredential,
	revokeOtlpCredential,
	rotateOtlpCredential,
} from "../../src/db/otlp-credentials.js";
import * as postgresModule from "../../src/db/postgres.js";
import { startOtlpGrpcServer } from "../../src/lib/otlp-grpc.js";
import {
	metricSeriesId,
	normalizeMetricExport,
} from "../../src/lib/otlp-metrics.js";
import { durableActorId } from "../../src/middleware/auth.js";
import { resolveTenantProject } from "../../src/tenancy.js";
import {
	decodeMetricsResponse,
	exemplar,
	exemplarSpan,
	exemplarTime,
	exemplarTrace,
	gauge,
	histogram,
	type Metric,
	metricExport,
	metricKinds,
	metricStart,
	metricsProtobuf,
	metricTime,
	numberPoint,
	stringAttribute,
} from "../fixtures/otlp-metrics.js";
import { otlpDisposableDatastores } from "../helpers/otlp-disposable-datastores.js";

// Read contract: one item per retained data point, with OTLP AnyValue attributes
// and a lossless OTLP-JSON data_point; series_id identifies the original series.
type MetricRow = {
	organization_id: string;
	project_id: string;
	name: string;
	metric_type: string;
	unit: string;
	aggregation_temporality: number;
	is_monotonic: boolean;
	series_id: string;
	resource_attributes: unknown[];
	resource_schema_url: string;
	scope_name: string;
	scope_version: string;
	scope_attributes: unknown[];
	scope_schema_url: string;
	data_point: Record<string, unknown>;
};
const database = `otlp_extension_${randomUUID().replaceAll("-", "")}`;
const organizationId = randomUUID();
const projectId = randomUUID();
const otherOrganizationId = randomUUID();
const otherProjectId = randomUUID();
const password = () => randomBytes(32).toString("base64url");
const accounts = [
	{
		username: "metrics-admin",
		password: password(),
		organization_id: organizationId,
	},
	{
		username: "metrics-user",
		password: password(),
		organization_id: organizationId,
	},
	{
		username: "metrics-reader",
		password: password(),
		organization_id: organizationId,
	},
	{
		username: "metrics-other",
		password: password(),
		organization_id: otherOrganizationId,
	},
];
const auth = (index = 0) => {
	const account = accounts[index]!;
	return `Basic ${Buffer.from(`${account.username}:${account.password}`).toString("base64")}`;
};
const adminPrincipal = {
	organizationId,
	actorId: durableActorId(accounts[0]!.username),
};
const grpcPath =
	"/opentelemetry.proto.collector.metrics.v1.MetricsService/Export";
const envKeys = [
	"GLASSHOUSE_BASIC_AUTH_CREDENTIALS",
	"GLASSHOUSE_DEFAULT_ORGANIZATION_ID",
	"GLASSHOUSE_PUBLIC_ORIGIN",
	"GLASSHOUSE_REDACT_KEYS",
	"GLASSHOUSE_REDACT_INPUT",
	"API_MAX_BODY_BYTES",
	"VALKEY_PUBSUB_URL",
	"OTLP_GRPC_HOST",
	"OTLP_GRPC_PORT",
	"OTLP_GRPC_MAX_RECEIVE_BYTES",
] as const;
const originalEnv = Object.fromEntries(
	envKeys.map((key) => [key, process.env[key]]),
);
let pgAdmin: Pool;
let pool: Pool;
let fencePool: Pool;
let chAdmin: ClickHouseClient;
let clickhouse: ClickHouseClient;
let createdPostgres = false;
let createdClickhouse = false;
let server: ReturnType<typeof Bun.serve>;
let grpcClient: grpc.Client;
let grpcEndpoint: string;
let stopGrpc: Awaited<ReturnType<typeof startOtlpGrpcServer>>;
let createApiApp: typeof import("../../src/index.js").createApiApp;
const redirects: { mockRestore: () => void }[] = [];

beforeAll(async () => {
	const config = otlpDisposableDatastores(process.env, database);
	pgAdmin = new Pool({ connectionString: config.postgresAdminUrl });
	await pgAdmin.query(`CREATE DATABASE ${database}`);
	createdPostgres = true;
	pool = new Pool({ connectionString: config.postgresUrl, max: 12 });
	fencePool = new Pool({ connectionString: config.postgresUrl, max: 10 });
	expect(
		(await pool.query("SELECT current_database() AS database")).rows[0]
			?.database,
	).toBe(database);
	await migrate({ DATABASE_URL: config.postgresUrl });
	chAdmin = createClient(config.clickhouseAdminOptions);
	await chAdmin.command({ query: `CREATE DATABASE ${database}` });
	createdClickhouse = true;
	clickhouse = createClient(config.clickhouseOptions);
	const selected = await clickhouse.query({
		query: "SELECT currentDatabase() AS database",
		format: "JSONEachRow",
	});
	expect((await selected.json<{ database: string }>())[0]?.database).toBe(
		database,
	);
	await applyClickHouseMigrations(
		createClient(config.clickhouseOptions),
		async (run) => run(),
	);
	for (const [organization, project] of [
		[organizationId, projectId],
		[otherOrganizationId, otherProjectId],
	]) {
		await pool.query(
			`WITH o AS (INSERT INTO organizations (id, name, slug, default_project_id)
			 VALUES ($1::uuid, 'Metrics regression', $1::text, $2::uuid) RETURNING id)
			 INSERT INTO projects (id, organization_id, name, slug)
			 SELECT $2::uuid, id, 'Default', 'default' FROM o`,
			[organization, project],
		);
	}
	process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = JSON.stringify(accounts);
	process.env.GLASSHOUSE_DEFAULT_ORGANIZATION_ID = organizationId;
	process.env.GLASSHOUSE_REDACT_KEYS = "secret";
	process.env.GLASSHOUSE_REDACT_INPUT = "false";
	process.env.API_MAX_BODY_BYTES = "1048576";
	delete process.env.GLASSHOUSE_PUBLIC_ORIGIN;
	delete process.env.VALKEY_PUBSUB_URL;
	for (const username of [accounts[0]!.username, accounts[3]!.username]) {
		await bootstrapAuthorization({
			...process.env,
			DATABASE_URL: config.postgresUrl,
			GLASSHOUSE_AUTH_BOOTSTRAP_MODE: "basic",
			GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: username,
		});
	}
	for (const [index, role] of [
		[1, "user"],
		[2, "read_only"],
	] as const) {
		await pool.query(
			"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, $3)",
			[organizationId, durableActorId(accounts[index]!.username), role],
		);
	}
	await pool.query(
		"UPDATE authorization_policy_settings SET strict_enforcement = true, enabled_at = now() WHERE organization_id IN ($1, $2)",
		[organizationId, otherOrganizationId],
	);
	// Redirect connection providers to real disposable databases only. Authentication,
	// authorization locks, redaction, writers, queries and destructive stages stay real.
	redirects.push(spyOn(postgresModule, "pgPool").mockReturnValue(pool));
	redirects.push(
		spyOn(postgresModule, "authenticationPool").mockReturnValue(fencePool),
	);
	redirects.push(spyOn(clickhouseModule, "ch").mockReturnValue(clickhouse));
	({ createApiApp } = await import("../../src/index.js"));
	const app = createApiApp({
		pgPool: () => pool,
		authenticationPool: () => fencePool,
	});
	server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
	const port = await unusedPort();
	process.env.OTLP_GRPC_HOST = "127.0.0.1";
	process.env.OTLP_GRPC_PORT = String(port);
	process.env.OTLP_GRPC_MAX_RECEIVE_BYTES = "1048576";
	grpcEndpoint = `http://127.0.0.1:${port}`;
	stopGrpc = await startOtlpGrpcServer(app.fetch);
	grpcClient = new grpc.Client(
		`127.0.0.1:${port}`,
		grpc.credentials.createInsecure(),
		{ "grpc.default_compression_algorithm": 2 },
	);
}, 60_000);

afterAll(async () => {
	grpcClient?.close();
	await stopGrpc?.();
	server?.stop(true);
	for (const redirect of redirects.reverse()) redirect.mockRestore();
	await clickhouse?.close();
	await fencePool?.end();
	await pool?.end();
	try {
		if (createdClickhouse)
			await chAdmin.command({ query: `DROP DATABASE ${database} SYNC` });
	} finally {
		try {
			if (createdPostgres)
				await pgAdmin.query(`DROP DATABASE ${database} WITH (FORCE)`);
		} finally {
			await chAdmin?.close();
			await pgAdmin?.end();
			for (const key of envKeys) {
				if (originalEnv[key] === undefined) delete process.env[key];
				else process.env[key] = originalEnv[key];
			}
		}
	}
});

async function unusedPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = createServer();
		socket.once("error", reject);
		socket.listen(0, "127.0.0.1", () => {
			const address = socket.address();
			if (!address || typeof address === "string")
				return reject(new Error("No loopback port"));
			socket.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}

const marker = () => `metrics.${randomUUID()}`;
const post = (
	payload: unknown,
	project: string | null = projectId,
	authorization = auth(),
	extra: Record<string, string> = {},
) =>
	fetch(new URL("/v1/metrics", server.url), {
		method: "POST",
		headers: {
			authorization,
			"content-type": "application/json",
			...(project === null ? {} : { "x-glasshouse-project-id": project }),
			...extra,
		},
		body: JSON.stringify(payload),
	});
const product = (
	path: string,
	method = "GET",
	body?: unknown,
	authorization = auth(),
) =>
	fetch(new URL(path, server.url), {
		method,
		headers: { authorization, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

async function stored(
	prefix: string,
	project = projectId,
): Promise<MetricRow[]> {
	const result = await clickhouse.query({
		query:
			"SELECT * FROM metrics WHERE project_id = {project:String} AND startsWith(name, {prefix:String})",
		query_params: { project, prefix },
		format: "JSONEachRow",
	});
	return (await result.json<Record<string, unknown>>()).map((row) => {
		for (const key of [
			"resource_attributes",
			"scope_attributes",
			"data_point",
		]) {
			if (typeof row[key] === "string") row[key] = JSON.parse(row[key]);
		}
		return row as MetricRow;
	});
}

async function read(
	prefix: string,
	project = projectId,
	authorization = auth(),
) {
	const response = await product(
		`/v1/metrics?project_id=${project}&limit=200`,
		"GET",
		undefined,
		authorization,
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { items: MetricRow[] };
	expect(Array.isArray(body.items)).toBe(true);
	return body.items.filter((row) => row.name.startsWith(prefix));
}

async function credential(project = projectId, actor = adminPrincipal.actorId) {
	return createOtlpCredential(pool, {
		organization_id: organizationId,
		project_id: project,
		name: "Synthetic metrics collector",
		created_by_actor_id: actor,
	});
}

async function newProject() {
	const id = randomUUID();
	await pool.query(
		"INSERT INTO projects (id, organization_id, name, slug) VALUES ($1::uuid, $2::uuid, 'Metrics disposable', $1::text)",
		[id, organizationId],
	);
	return id;
}

async function approveMetricRetention(id: string) {
	const draft = await product("/v1/governance/policy/drafts", "POST", {
		project_id: id,
		retention: { metrics: 1 },
		redaction: { mode: "none", keys: [] },
	});
	expect(draft.status).toBe(201);
	const { policy } = (await draft.json()) as { policy: { id: string } };
	expect(
		(
			await product(
				`/v1/governance/policy/${policy.id}/approve?project_id=${id}`,
				"POST",
			)
		).status,
	).toBe(200);
}

async function metricRetentionPreview(id: string) {
	const preview = await product("/v1/governance/retention/preview", "POST", {
		project_id: id,
	});
	expect(preview.status).toBe(200);
	return preview.json() as Promise<{
		preview_id: string;
		policy_version_id: string;
		counts: { metrics: number };
	}>;
}

function rpc(
	payload: Buffer,
	authorization = auth(),
	project = projectId,
	extras?: (metadata: grpc.Metadata) => void,
): Promise<Buffer> {
	const metadata = new grpc.Metadata();
	if (authorization) metadata.set("authorization", authorization);
	if (project) metadata.set("x-glasshouse-project-id", project);
	extras?.(metadata);
	return new Promise((resolve, reject) => {
		grpcClient.makeUnaryRequest(
			grpcPath,
			(value: Buffer) => value,
			(value: Buffer) => value,
			payload,
			metadata,
			{ deadline: Date.now() + 5_000 },
			(error, response) => (error ? reject(error) : resolve(response)),
		);
	});
}

test("metrics has real tenant-bearing ClickHouse storage after the normal migrations", async () => {
	const result = await clickhouse.query({
		query:
			"SELECT name FROM system.tables WHERE database = currentDatabase() AND name = 'metrics'",
		format: "JSONEachRow",
	});
	expect(await result.json()).toEqual([{ name: "metrics" }]);
});

test("metric key migration backfills existing Projects, provisions new ones, enforces scope and preserves keys on replay", async () => {
	const client = await pool.connect();
	try {
		await client.query(
			await Bun.file(
				resolve(
					import.meta.dir,
					"../../../../infra/scripts/test-db-migrations-90063.assert.sql",
				),
			).text(),
		);
		const before = await client.query(
			"SELECT project_id, secret_key FROM project_metric_identity_keys ORDER BY project_id",
		);
		expect(before.rows.length).toBeGreaterThan(1);
		expect(
			new Set(before.rows.map((row) => row.secret_key.toString("hex"))).size,
		).toBe(before.rows.length);
		const migration = await Bun.file(
			resolve(
				import.meta.dir,
				"../../../../infra/db/migrations/90063_metric_identity_keys.sql",
			),
		).text();
		await client.query(migration);
		await client.query(migration);
		expect(
			(
				await client.query(
					"SELECT project_id, secret_key FROM project_metric_identity_keys ORDER BY project_id",
				)
			).rows,
		).toEqual(before.rows);
	} finally {
		await client.query("ROLLBACK");
		client.release();
	}
});

test("exposed series and point IDs use the durable Project secret rather than an offline payload dictionary", async () => {
	const name = marker();
	const payload = metricExport([
		gauge(name, [stringAttribute("secret", "yes")]),
	]);
	expect((await post(payload)).status).toBe(200);
	const key = (
		await pool.query(
			"SELECT secret_key FROM project_metric_identity_keys WHERE organization_id = $1 AND project_id = $2",
			[organizationId, projectId],
		)
	).rows[0]!.secret_key as Buffer;
	const wrongKey = randomBytes(32);
	const point = normalizeMetricExport(payload)[0]!;
	const digest = createHash("sha256")
		.update(
			JSON.stringify([
				"otlp-metrics-wire-v1",
				organizationId,
				projectId,
				"json",
			]),
		)
		.update(JSON.stringify(payload))
		.digest("hex");
	const [row] = (await read(name)) as (MetricRow & { point_id: string })[];
	expect(row!.series_id).toBe(
		metricSeriesId(point, organizationId, projectId, key),
	);
	expect(row!.series_id).not.toBe(
		metricSeriesId(point, organizationId, projectId, wrongKey),
	);
	expect(row!.point_id).toBe(
		createHmac("sha256", key)
			.update(`metrics-point-v2:${digest}:0`)
			.digest("hex"),
	);
	expect(row!.point_id).not.toBe(
		createHash("sha256").update(`${digest}:0`).digest("hex"),
	);
	expect(JSON.stringify(row)).not.toContain(key.toString("hex"));
	expect(JSON.stringify(row)).not.toContain('"stringValue":"yes"');
	const later = structuredClone(payload);
	later.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.gauge!
		.dataPoints[0]!.timeUnixNano = (BigInt(metricTime) + 1n).toString();
	expect((await post(later)).status).toBe(200);
	expect(new Set((await stored(name)).map((row) => row.series_id)).size).toBe(
		1,
	);
});

test("metrics pagination bounds every page and rejects cursors from another Project or filter", async () => {
	const name = marker();
	const payload = metricExport([
		{
			name,
			gauge: {
				dataPoints: Array.from({ length: 5 }, (_, i) => ({
					...numberPoint(),
					timeUnixNano: (BigInt(metricTime) + BigInt(i)).toString(),
				})),
			},
		},
	]);
	expect((await post(payload)).status).toBe(200);
	const first = await product(
		`/v1/metrics?project_id=${projectId}&name=${name}&limit=2`,
	);
	expect(first.status).toBe(200);
	const page = (await first.json()) as {
		items: { point_id: string; time_unix_nano: string }[];
		next_cursor: string;
	};
	expect(page.items).toHaveLength(2);
	expect(page.items[0]!.time_unix_nano).toBe(
		(BigInt(metricTime) + 4n).toString(),
	);
	expect(page.next_cursor).toBeString();
	const next = await product(
		`/v1/metrics?project_id=${projectId}&name=${name}&limit=2&cursor=${page.next_cursor}`,
	);
	expect(next.status).toBe(200);
	const second = (await next.json()) as typeof page;
	expect(second.items).toHaveLength(2);
	expect(
		new Set([...page.items, ...second.items].map((row) => row.point_id)).size,
	).toBe(4);
	for (const suffix of [
		`project_id=${projectId}&name=wrong`,
		`project_id=${otherProjectId}&name=${name}`,
	]) {
		expect(
			(
				await product(
					`/v1/metrics?${suffix}&cursor=${page.next_cursor}`,
					"GET",
					undefined,
					suffix.includes(otherProjectId) ? auth(3) : auth(),
				)
			).status,
		).toBe(400);
	}
});

test("metrics reads and cursors use the authorized canonical Project UUID across valid spellings", async () => {
	const name = marker();
	expect(
		(
			await post(
				metricExport([
					{
						name,
						gauge: {
							dataPoints: Array.from({ length: 3 }, (_, i) => ({
								...numberPoint(),
								timeUnixNano: (BigInt(metricTime) + BigInt(i)).toString(),
							})),
						},
					},
				]),
			)
		).status,
	).toBe(200);
	expect(await stored(name)).toHaveLength(3);
	const spellings = [
		projectId.toUpperCase(),
		projectId,
		projectId.replace(/[a-f]/g, (letter, index) =>
			index % 2 ? letter : letter.toUpperCase(),
		),
	];
	const page = async (
		project: string,
		cursor?: string,
		authorization = auth(),
		filter = name,
	) => {
		const query = new URLSearchParams({
			project_id: project,
			name: filter,
			limit: "1",
		});
		if (cursor) query.set("cursor", cursor);
		return product(`/v1/metrics?${query}`, "GET", undefined, authorization);
	};
	for (const spelling of spellings) {
		const first = await page(spelling);
		expect(first.status).toBe(200);
		const body = (await first.json()) as {
			items: { point_id: string; project_id: string }[];
			next_cursor: string;
		};
		expect(body.items).toHaveLength(1);
		expect(body.items[0]!.project_id).toBe(projectId);
		expect(
			JSON.parse(Buffer.from(body.next_cursor, "base64url").toString()).project,
		).toBe(projectId);
		for (const continuation of spellings) {
			const next = await page(continuation, body.next_cursor);
			expect(next.status).toBe(200);
			const second = (await next.json()) as typeof body;
			expect(second.items).toHaveLength(1);
			expect(second.items[0]!.point_id).not.toBe(body.items[0]!.point_id);
		}
		expect((await page(otherProjectId, body.next_cursor, auth(3))).status).toBe(
			400,
		);
		expect(
			(await page(projectId, body.next_cursor, auth(), `${name}.other`)).status,
		).toBe(400);
		expect((await page(projectId, body.next_cursor, auth(3))).status).toBe(404);
	}
	for (const invalid of [
		` ${projectId}`,
		`${projectId} `,
		`{${projectId}}`,
		projectId.replaceAll("-", ""),
		`${projectId}x`,
	])
		expect((await page(invalid)).status).toBe(400);
});

test("known-depth, node and series limits reject atomically through real HTTP and protobuf boundaries", async () => {
	const name = marker();
	let value: Record<string, unknown> = { stringValue: "too deep" };
	for (let i = 0; i < 40; i++) value = { arrayValue: { values: [value] } };
	const payload = metricExport([gauge(name, [{ key: "deep", value }])]);
	expect((await post(payload)).status).toBe(400);
	const response = await fetch(new URL("/v1/metrics", server.url), {
		method: "POST",
		headers: {
			authorization: auth(),
			"x-glasshouse-project-id": projectId,
			"content-type": "application/x-protobuf",
		},
		body: metricsProtobuf(payload),
	});
	expect(response.status).toBe(400);
	const wide = metricExport([
		{
			name,
			gauge: { dataPoints: Array.from({ length: 2001 }, () => numberPoint()) },
		},
	]);
	expect((await post(wide)).status).toBe(400);
	const attribute = {
		key: "wide",
		value: { arrayValue: { values: Array.from({ length: 128 }, () => ({})) } },
	};
	const nodes = metricExport([
		{
			name,
			gauge: {
				dataPoints: Array.from({ length: 800 }, () => numberPoint([attribute])),
			},
		},
	]);
	expect(Buffer.byteLength(JSON.stringify(nodes))).toBeLessThan(1_048_576);
	expect((await post(nodes)).status).toBe(400);
	expect(await stored(name)).toHaveLength(0);
});

for (const transport of ["json", "protobuf", "grpc"] as const) {
	test(`${transport} persists every metric kind, exact nanoseconds and 64-bit values, then reads them through the authorized API`, async () => {
		const prefix = marker();
		const payload = metricExport(metricKinds(prefix), [
			stringAttribute("service.name", "metrics-regression"),
		]);
		if (transport === "json") {
			const response = await post(payload);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({});
		} else if (transport === "protobuf") {
			const response = await fetch(new URL("/v1/metrics", server.url), {
				method: "POST",
				headers: {
					authorization: auth(),
					"x-glasshouse-project-id": projectId,
					"content-type": "application/x-protobuf",
					"content-encoding": "gzip",
				},
				body: gzipSync(metricsProtobuf(payload)),
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain(
				"application/x-protobuf",
			);
			expect(
				decodeMetricsResponse(new Uint8Array(await response.arrayBuffer())),
			).toEqual({});
		} else {
			expect(
				decodeMetricsResponse(await rpc(metricsProtobuf(payload))),
			).toEqual({});
		}
		const rows = await stored(prefix);
		expect(rows).toHaveLength(5);
		const publicRows = await read(prefix);
		expect(publicRows).toHaveLength(5);
		for (const row of rows) {
			expect(row).toMatchObject({
				organization_id: organizationId,
				project_id: projectId,
				scope_name: "glasshouse.metrics.regression",
				scope_version: "1.0.0",
				resource_schema_url: payload.resourceMetrics[0]!.schemaUrl,
				scope_schema_url:
					payload.resourceMetrics[0]!.scopeMetrics[0]!.schemaUrl,
			});
			expect(row.data_point).toMatchObject({
				startTimeUnixNano: metricStart,
				timeUnixNano: metricTime,
			});
			expect(row.series_id).toBeString();
			expect(row.series_id.length).toBeGreaterThan(0);
			expect(publicRows.find((item) => item.name === row.name)).toMatchObject({
				name: row.name,
				metric_type: row.metric_type,
				series_id: row.series_id,
				data_point: row.data_point,
				resource_attributes: row.resource_attributes,
				scope_attributes: row.scope_attributes,
			});
		}
		const byType = new Map(rows.map((row) => [row.metric_type, row]));
		expect([...byType.keys()].sort()).toEqual([
			"exponential_histogram",
			"gauge",
			"histogram",
			"sum",
			"summary",
		]);
		expect(byType.get("gauge")?.data_point.asInt).toBe("9007199254740993");
		expect(byType.get("sum")).toMatchObject({
			aggregation_temporality: 2,
			is_monotonic: true,
		});
		expect(byType.get("histogram")).toMatchObject({
			aggregation_temporality: 1,
			data_point: {
				count: "4",
				sum: 7,
				min: 0,
				max: 4,
				explicitBounds: [1, 2],
				bucketCounts: ["1", "2", "1"],
				exemplars: [
					{
						timeUnixNano: exemplarTime,
						traceId: exemplarTrace,
						spanId: exemplarSpan,
						asDouble: 1.5,
						filteredAttributes: [stringAttribute("sample", "retained")],
					},
				],
			},
		});
		expect(byType.get("exponential_histogram")?.data_point).toMatchObject({
			count: "6",
			sum: -2.375,
			scale: -1,
			zeroCount: "1",
			zeroThreshold: 0.001,
			positive: { offset: -2, bucketCounts: ["1", "2"] },
			negative: { offset: 0, bucketCounts: ["2"] },
		});
		expect(byType.get("summary")?.data_point.quantileValues).toEqual([
			{ quantile: 0.5, value: 1.5 },
			{ quantile: 1, value: 4 },
		]);
		const traces = await clickhouse.query({
			query:
				"SELECT (SELECT count() FROM traces) + (SELECT count() FROM observations) AS count",
			format: "JSONEachRow",
		});
		expect(Number((await traces.json<{ count: string }>())[0]?.count)).toBe(0);
	});
}

for (const transport of ["json", "protobuf"] as const) {
	test(`${transport} preserves protocol special doubles and sint32 exponential histogram scale`, async () => {
		const name = marker();
		const values =
			transport === "json"
				? ["NaN", "Infinity", "-Infinity", "-0"]
				: [NaN, Infinity, -Infinity, -0];
		const metric = metricKinds(name)[3]!;
		metric.exponentialHistogram!.dataPoints[0]!.scale = 21;
		const payload = metricExport([
			{
				name,
				gauge: {
					dataPoints: values.map((asDouble, i) => ({
						timeUnixNano: metricTime,
						asDouble,
						attributes: [stringAttribute("case", String(i))],
					})),
				},
			},
			metric,
		]);
		const response =
			transport === "json"
				? await post(payload)
				: await fetch(new URL("/v1/metrics", server.url), {
						method: "POST",
						headers: {
							authorization: auth(),
							"x-glasshouse-project-id": projectId,
							"content-type": "application/x-protobuf",
						},
						body: metricsProtobuf(payload),
					});
		expect(response.status).toBe(200);
		const rows = await read(name);
		expect(rows).toHaveLength(5);
		expect(
			rows.find((row) => row.metric_type === "exponential_histogram")!
				.data_point.scale,
		).toBe(21);
		expect(
			rows
				.filter((row) => row.metric_type === "gauge")
				.map((row) => row.data_point.asDouble)
				.sort(),
		).toEqual(["NaN", "Infinity", "-Infinity", "-0"].sort());
	});
}

for (const kind of ["histogram", "exponentialHistogram", "summary"] as const) {
	test(`ProtoJSON quoted finite ${kind} doubles match numeric JSON and protobuf readback`, async () => {
		const name = marker();
		const metric =
			metricKinds(name)[
				kind === "histogram" ? 2 : kind === "exponentialHistogram" ? 3 : 4
			]!;
		const point = metric[kind]!.dataPoints[0]!;
		if (kind === "histogram") {
			point.explicitBounds = [0.10000000000000002, 1e100];
			point.sum = 3e100;
			point.max = 2e100;
		} else if (kind === "exponentialHistogram") point.zeroThreshold = 5e-324;
		else {
			point.sum = 1.7976931348623157e308;
			point.quantileValues = [
				{ quantile: 0.10000000000000002, value: 5e-324 },
				{ quantile: 1, value: 1.7976931348623157e308 },
			];
		}
		const payload = metricExport([metric]);
		const protobuf = await fetch(new URL("/v1/metrics", server.url), {
			method: "POST",
			headers: {
				authorization: auth(),
				"x-glasshouse-project-id": projectId,
				"content-type": "application/x-protobuf",
			},
			body: metricsProtobuf(payload),
		});
		expect(protobuf.status).toBe(200);
		expect((await post(payload)).status).toBe(200);
		const numericRows = await read(name);
		expect(numericRows).toHaveLength(2);
		const field =
			kind === "histogram"
				? "explicitBounds"
				: kind === "exponentialHistogram"
					? "zeroThreshold"
					: "quantileValues";
		expect(numericRows[0]!.data_point[field]).toEqual(point[field]);
		expect(numericRows[0]!.data_point).toEqual(numericRows[1]!.data_point);
		const quoted = structuredClone(payload);
		const quotedPoint =
			quoted.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]![kind]!
				.dataPoints[0]!;
		if (kind === "histogram")
			quotedPoint.explicitBounds = ["0.10000000000000002", "1E+100"];
		else if (kind === "exponentialHistogram")
			quotedPoint.zeroThreshold = "5e-324";
		else
			quotedPoint.quantileValues = [
				{ quantile: "0.10000000000000002", value: "5e-324" },
				{ quantile: "1e0", value: "1.7976931348623157e308" },
			];
		expect((await post(quoted)).status).toBe(200);
		const rows = await read(name);
		expect(rows).toHaveLength(3);
		for (const row of rows)
			expect(row.data_point).toEqual(numericRows[0]!.data_point);
	});
}

for (const temporality of [1, 2]) {
	for (const monotonic of [false, true]) {
		test(`sum preserves temporality ${temporality} and monotonic=${monotonic} without adding cumulative snapshots`, async () => {
			const name = marker();
			const metric: Metric = {
				name,
				sum: {
					aggregationTemporality: temporality,
					isMonotonic: monotonic,
					dataPoints: [
						{ ...numberPoint(), asInt: monotonic ? "3" : "-3" },
						{
							...numberPoint(),
							startTimeUnixNano: temporality === 1 ? metricTime : metricStart,
							timeUnixNano: (BigInt(metricTime) + 1n).toString(),
							asInt: monotonic ? "5" : "-5",
						},
					],
				},
			};
			expect((await post(metricExport([metric]))).status).toBe(200);
			const rows = await stored(name);
			expect(rows).toHaveLength(2);
			expect(new Set(rows.map((row) => row.series_id)).size).toBe(1);
			for (const row of rows)
				expect(row).toMatchObject({
					aggregation_temporality: temporality,
					is_monotonic: monotonic,
				});
			expect(rows.map((row) => row.data_point.asInt).sort()).toEqual(
				monotonic ? ["3", "5"] : ["-3", "-5"],
			);
			expect(rows.map((row) => row.data_point.timeUnixNano).sort()).toEqual([
				metricTime,
				(BigInt(metricTime) + 1n).toString(),
			]);
		});
	}
}

test("JSON null/zero semantics preserve signed integers, zero doubles, no-recorded-value flags and empty envelopes", async () => {
	const prefix = marker();
	const payload = metricExport([
		{
			name: prefix,
			gauge: {
				dataPoints: [
					{
						...numberPoint(),
						asInt: "-9007199254740993",
						attributes: [stringAttribute("case", "integer")],
					},
					{
						startTimeUnixNano: "0",
						timeUnixNano: metricTime,
						asDouble: 0,
						attributes: [stringAttribute("case", "zero")],
					},
					{
						timeUnixNano: metricTime,
						flags: 1,
						attributes: [stringAttribute("case", "absent")],
					},
				],
			},
		},
	]);
	expect(
		(await post({ resourceMetrics: [{}, ...payload.resourceMetrics] })).status,
	).toBe(200);
	const rows = await stored(prefix);
	expect(rows).toHaveLength(3);
	expect(rows.some((row) => row.data_point.asInt === "-9007199254740993")).toBe(
		true,
	);
	expect(rows.some((row) => row.data_point.asDouble === 0)).toBe(true);
	const absent = rows.find((row) => row.data_point.flags === 1)!;
	expect(absent.data_point).not.toHaveProperty("asInt");
	expect(absent.data_point).not.toHaveProperty("asDouble");
	expect((await post({ resourceMetrics: null })).status).toBe(200);
	expect((await post({ resourceMetrics: [null] })).status).toBe(400);
});

test("typed structured resource, scope, point and exemplar attributes survive redaction without collapsing distinct series", async () => {
	const prefix = marker();
	const secret = `synthetic-sensitive-${randomUUID()}`;
	const nested = {
		key: "nested",
		value: {
			kvlistValue: {
				values: [
					stringAttribute("secret", secret),
					{
						key: "array",
						value: {
							arrayValue: {
								values: [
									{ boolValue: false },
									{ intValue: "9007199254740993" },
									{ bytesValue: "AAEC" },
									{
										kvlistValue: {
											values: [
												stringAttribute("secret", secret),
												stringAttribute("safe", "retained"),
											],
										},
									},
								],
							},
						},
					},
				],
			},
		},
	};
	const attributes = [nested, { key: "double", value: { doubleValue: 0.25 } }];
	const sensitiveAttributes = [
		...attributes,
		stringAttribute("secret", secret),
	];
	const metric = histogram(prefix);
	metric.histogram!.dataPoints = ["one", "two"].map((series) => ({
		...metric.histogram!.dataPoints[0],
		attributes: [
			...attributes,
			stringAttribute("secret", `${secret}-${series}`),
		],
		exemplars: [{ ...exemplar(), filteredAttributes: sensitiveAttributes }],
	}));
	const payload = metricExport([metric], sensitiveAttributes, {
		name: "structured",
		version: "1",
		attributes: sensitiveAttributes,
	});
	expect((await post(payload)).status).toBe(200);
	const rows = await stored(prefix);
	expect(rows).toHaveLength(2);
	expect(new Set(rows.map((row) => row.series_id)).size).toBe(2);
	for (const row of rows) {
		const retained = JSON.stringify(row);
		expect(retained).not.toContain(secret);
		expect(retained).not.toContain('"key":"secret"');
		for (const attrs of [
			row.resource_attributes,
			row.scope_attributes,
			row.data_point.attributes,
			(row.data_point.exemplars as Record<string, unknown>[])[0]!
				.filteredAttributes,
		]) {
			const json = JSON.stringify(attrs);
			expect(json).toContain('"boolValue":false');
			expect(json).toContain('"intValue":"9007199254740993"');
			expect(json).toContain('"bytesValue":"AAEC"');
			expect(json).toContain("retained");
		}
	}
	expect(JSON.stringify(await read(prefix))).not.toContain(secret);
});

test("series identity is canonical across attribute order but separates resource, scope, schema, type and unit", async () => {
	const name = marker();
	const a = stringAttribute("a", "1");
	const b = stringAttribute("b", "2");
	const make = (attrs = [a, b]) => metricExport([gauge(name, attrs)], [a, b]);
	const first = make();
	const reordered = make([b, a]);
	reordered.resourceMetrics[0]!.resource.attributes.reverse();
	const variants = Array.from({ length: 7 }, () => make());
	variants[0]!.resourceMetrics[0]!.resource.attributes[0] = stringAttribute(
		"a",
		"different",
	);
	variants[1]!.resourceMetrics[0]!.scopeMetrics[0]!.scope.version = "2";
	variants[2]!.resourceMetrics[0]!.scopeMetrics[0]!.scope.attributes = [
		stringAttribute("scope.label", "different"),
	];
	variants[3]!.resourceMetrics[0]!.schemaUrl += "/different";
	variants[4]!.resourceMetrics[0]!.scopeMetrics[0]!.schemaUrl += "/different";
	variants[5]!.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.unit = "s";
	variants[6]!.resourceMetrics[0]!.scopeMetrics[0]!.metrics = [
		{
			name,
			unit: "1",
			sum: {
				aggregationTemporality: 2,
				isMonotonic: true,
				dataPoints: [numberPoint([a, b])],
			},
		},
	];
	for (const payload of [first, reordered, ...variants])
		expect((await post(payload)).status).toBe(200);
	const rows = await stored(name);
	// The same series/time may be stored once or twice; identity must be stable.
	expect(new Set(rows.map((row) => row.series_id)).size).toBe(8);
	const original = rows.filter(
		(row) =>
			row.metric_type === "gauge" &&
			row.unit === "1" &&
			row.scope_version === "1.0.0" &&
			row.resource_schema_url === first.resourceMetrics[0]!.schemaUrl &&
			row.scope_schema_url ===
				first.resourceMetrics[0]!.scopeMetrics[0]!.schemaUrl &&
			JSON.stringify(row.resource_attributes).includes('"stringValue":"1"') &&
			JSON.stringify(row.scope_attributes).includes('"stringValue":"retained"'),
	);
	expect(original.length).toBeGreaterThan(0);
	expect(new Set(original.map((row) => row.series_id)).size).toBe(1);
});

test("attribute types and lossless integer values remain part of series identity", async () => {
	const name = marker();
	const values = [
		{ stringValue: "1" },
		{ intValue: "1" },
		{ boolValue: true },
		{ intValue: "9007199254740992" },
		{ intValue: "9007199254740993" },
	];
	const points = values.map((value) => numberPoint([{ key: "typed", value }]));
	expect(
		(await post(metricExport([{ name, gauge: { dataPoints: points } }])))
			.status,
	).toBe(200);
	const rows = await stored(name);
	expect(rows).toHaveLength(5);
	expect(new Set(rows.map((row) => row.series_id)).size).toBe(5);
});

test("approved Project redaction adds a floor to resource, scope, point and exemplar attributes", async () => {
	const id = await newProject();
	const name = marker();
	const secret = `policy-sensitive-${randomUUID()}`;
	const draft = await product("/v1/governance/policy/drafts", "POST", {
		project_id: id,
		retention: { traces: 30 },
		redaction: { mode: "none", keys: ["policy.secret"] },
	});
	expect(draft.status).toBe(201);
	const version = (await draft.json()) as { policy: { id: string } };
	expect(
		(
			await product(
				`/v1/governance/policy/${version.policy.id}/approve?project_id=${id}`,
				"POST",
			)
		).status,
	).toBe(200);
	const attributes = [
		stringAttribute("policy.secret", secret),
		stringAttribute("safe", "retained"),
	];
	const metric = histogram(name);
	metric.histogram!.dataPoints[0]!.attributes = attributes;
	metric.histogram!.dataPoints[0]!.exemplars = [
		{ ...exemplar(), filteredAttributes: attributes },
	];
	expect(
		(
			await post(
				metricExport([metric], attributes, {
					name: "policy",
					version: "1",
					attributes,
				}),
				id,
			)
		).status,
	).toBe(200);
	const rows = await stored(name, id);
	expect(rows).toHaveLength(1);
	expect(JSON.stringify(rows)).not.toContain(secret);
	expect(JSON.stringify(rows)).not.toContain("policy.secret");
	expect(JSON.stringify(rows)).toContain("retained");
});

const invalidPoints: [string, (point: Record<string, unknown>) => void][] = [
	[
		"non-increasing bounds",
		(p) => {
			p.explicitBounds = [2, 1];
		},
	],
	[
		"duplicate bounds",
		(p) => {
			p.explicitBounds = [1, 1];
		},
	],
	[
		"bucket length",
		(p) => {
			p.bucketCounts = ["4"];
		},
	],
	[
		"bucket/count mismatch",
		(p) => {
			p.count = "5";
		},
	],
	[
		"negative bucket",
		(p) => {
			p.bucketCounts = ["-1", "4", "1"];
		},
	],
	[
		"invalid timestamp",
		(p) => {
			p.timeUnixNano = "18446744073709551616";
		},
	],
	[
		"fractional timestamp",
		(p) => {
			p.timeUnixNano = "1793880000123456789.5";
		},
	],
	[
		"reversed interval",
		(p) => {
			p.startTimeUnixNano = (BigInt(metricTime) + 1n).toString();
		},
	],
	[
		"bad exemplar trace ID",
		(p) => {
			p.exemplars = [{ ...exemplar(), traceId: "not-a-trace" }];
		},
	],
	[
		"bad exemplar span ID",
		(p) => {
			p.exemplars = [{ ...exemplar(), spanId: "00" }];
		},
	],
	[
		"exemplar before interval",
		(p) => {
			p.exemplars = [{ ...exemplar(), timeUnixNano: "1" }];
		},
	],
	[
		"exemplar after interval",
		(p) => {
			p.exemplars = [
				{
					...exemplar(),
					timeUnixNano: (BigInt(metricTime) + 1n).toString(),
				},
			];
		},
	],
];
for (const [label, mutate] of invalidPoints) {
	test(`rejects ${label} atomically instead of acknowledging lost or coerced metric data`, async () => {
		const name = marker();
		const bad = histogram(name);
		mutate(bad.histogram!.dataPoints[0]!);
		expect(
			(await post(metricExport([gauge(`${name}.sentinel`), bad]))).status,
		).toBe(400);
		expect(await stored(name)).toHaveLength(0);
	});
}

const invalidMetrics: [string, (name: string) => Metric][] = [
	[
		"multiple metric kinds",
		(name) => ({
			...gauge(name),
			sum: {
				aggregationTemporality: 2,
				isMonotonic: true,
				dataPoints: [numberPoint()],
			},
		}),
	],
	[
		"multiple number values",
		(name) => ({
			name,
			gauge: { dataPoints: [{ ...numberPoint(), asDouble: 0.5 }] },
		}),
	],
	[
		"out-of-range signed value",
		(name) => ({
			name,
			gauge: {
				dataPoints: [{ ...numberPoint(), asInt: "9223372036854775808" }],
			},
		}),
	],
	[
		"unsafe numeric timestamp",
		(name) => ({
			name,
			gauge: {
				dataPoints: [{ ...numberPoint(), timeUnixNano: Number(metricTime) }],
			},
		}),
	],
	[
		"unspecified sum temporality",
		(name) => ({
			name,
			sum: {
				aggregationTemporality: 0,
				isMonotonic: true,
				dataPoints: [numberPoint()],
			},
		}),
	],
	[
		"exponential histogram count mismatch",
		(name) => {
			const metric = metricKinds(name)[3]!;
			metric.exponentialHistogram!.dataPoints[0]!.count = "7";
			return metric;
		},
	],
	[
		"exponential histogram sint32 scale overflow",
		(name) => {
			const metric = metricKinds(name)[3]!;
			metric.exponentialHistogram!.dataPoints[0]!.scale = 2_147_483_648;
			return metric;
		},
	],
	[
		"summary quantile outside [0,1]",
		(name) => {
			const metric = metricKinds(name)[4]!;
			metric.summary!.dataPoints[0]!.quantileValues = [
				{ quantile: 1.1, value: 4 },
			];
			return metric;
		},
	],
	[
		"negative summary quantile value",
		(name) => {
			const metric = metricKinds(name)[4]!;
			metric.summary!.dataPoints[0]!.quantileValues = [
				{ quantile: 0.5, value: -1 },
			];
			return metric;
		},
	],
];
for (const [label, make] of invalidMetrics) {
	test(`rejects ${label} without persisting the valid sibling`, async () => {
		const name = marker();
		expect(
			(await post(metricExport([gauge(`${name}.sentinel`), make(name)])))
				.status,
		).toBe(400);
		expect(await stored(name)).toHaveLength(0);
	});
}

test("rejects unbounded histogram buckets and exemplar lists without persisting a truncated distribution", async () => {
	for (const field of ["buckets", "exemplars"]) {
		const name = marker();
		const metric = histogram(name);
		const point = metric.histogram!.dataPoints[0]!;
		if (field === "buckets") {
			point.explicitBounds = Array.from({ length: 20_000 }, (_, i) => i);
			point.bucketCounts = Array(20_001).fill("1");
			point.count = "20001";
		} else point.exemplars = Array.from({ length: 1_024 }, exemplar);
		const response = await post(metricExport([metric]));
		expect([400, 413]).toContain(response.status);
		expect(await stored(name)).toHaveLength(0);
	}
});

test("HTTP rejects malformed protobuf and decompression bombs without acknowledging or retaining metrics", async () => {
	for (const [body, headers, status] of [
		[
			Buffer.from([0x0a, 0xff]),
			{ "content-type": "application/x-protobuf" },
			400,
		],
		[
			gzipSync(Buffer.from(" ".repeat(1_048_577))),
			{ "content-type": "application/json", "content-encoding": "gzip" },
			413,
		],
	] as const) {
		const response = await fetch(new URL("/v1/metrics", server.url), {
			method: "POST",
			headers: {
				authorization: auth(),
				"x-glasshouse-project-id": projectId,
				...headers,
			},
			body,
		});
		expect(response.status).toBe(status);
	}
	expect((await post({})).status).toBe(200);
});

test("identical protobuf retries across HTTP aliases, gzip and gRPC persist each point only once", async () => {
	const name = marker();
	const bytes = metricsProtobuf(metricExport([gauge(name)]));
	for (const contentType of [
		"application/x-protobuf",
		"application/protobuf",
	]) {
		const response = await fetch(new URL("/v1/metrics", server.url), {
			method: "POST",
			headers: {
				authorization: auth(),
				"x-glasshouse-project-id": projectId,
				"content-type": contentType,
				"content-encoding": "gzip",
			},
			body: gzipSync(bytes),
		});
		expect(response.status).toBe(200);
	}
	expect(decodeMetricsResponse(await rpc(bytes))).toEqual({});
	expect(await stored(name)).toHaveLength(1);
});

test("storage rejects unscoped metric rows and product reads bind both tenant keys", async () => {
	const name = marker();
	expect((await post(metricExport([gauge(name)]))).status).toBe(200);
	const result = await clickhouse.query({
		query:
			"SELECT * FROM metrics WHERE project_id = {project:String} AND name = {name:String}",
		query_params: { project: projectId, name },
		format: "JSONEachRow",
	});
	const [row] = await result.json<Record<string, unknown>>();
	expect(row).toBeDefined();
	for (const missing of ["organization_id", "project_id"]) {
		await expect(
			clickhouse.insert({
				table: "metrics",
				format: "JSONEachRow",
				values: [{ ...row, [missing]: "" }],
			}),
		).rejects.toThrow(/metrics_tenant_scope_required/);
	}
	await clickhouse.insert({
		table: "metrics",
		format: "JSONEachRow",
		values: [
			{
				...row,
				organization_id: otherOrganizationId,
				name: `${name}.foreign`,
				series_id: createHash("sha256").update(`foreign-${name}`).digest("hex"),
			},
		],
	});
	expect(await stored(name)).toHaveLength(2);
	expect((await read(name)).map((item) => item.name)).toEqual([name]);
});

test("project-bound bearer ingests metrics but grants no product reads or other methods", async () => {
	const name = marker();
	const created = await credential();
	const bearer = `Bearer ${created.secret}`;
	expect(
		(await post(metricExport([gauge(name)]), projectId, bearer)).status,
	).toBe(200);
	expect(await stored(name)).toHaveLength(1);
	for (const [path, method] of [
		[`/v1/metrics?project_id=${projectId}`, "GET"],
		[`/v1/metrics?project_id=${projectId}`, "PUT"],
		[`/v1/traces?project_id=${projectId}`, "GET"],
		["/v1/projects", "GET"],
	] as const) {
		expect((await product(path, method, undefined, bearer)).status).toBe(401);
	}
});

test("a Project-bound credential cannot select another Project in the same Organization over HTTP or gRPC", async () => {
	const id = await newProject();
	const name = marker();
	const payload = metricExport([gauge(name)]);
	const created = await credential();
	const bearer = `Bearer ${created.secret}`;
	expect((await post(payload, id, auth())).status).toBe(200);
	expect((await post(payload, id, bearer)).status).toBe(404);
	await expect(rpc(metricsProtobuf(payload), bearer, id)).rejects.toMatchObject(
		{ code: grpc.status.PERMISSION_DENIED },
	);
	expect(await stored(name, id)).toHaveLength(1);
	expect(await stored(name)).toHaveLength(0);
});

test("trusted tenant and Project selectors defeat missing headers, foreign resources and payload spoofing", async () => {
	const name = marker();
	const payload = metricExport([gauge(name)]);
	const bound = await credential();
	const bearer = `Bearer ${bound.secret}`;
	for (const [selector, authorization, status] of [
		[projectId, "", 401],
		[null, auth(), 404],
		["invalid", auth(), 404],
		[otherProjectId, auth(), 404],
		[projectId, auth(2), 404],
		[null, bearer, 404],
		[otherProjectId, bearer, 404],
	] as const) {
		expect((await post(payload, selector, authorization)).status).toBe(status);
	}
	const conflicting = metricExport(
		[gauge(name)],
		[stringAttribute("glasshouse.project.id", otherProjectId)],
	);
	expect((await post(conflicting)).status).toBe(404);
	const mixed = {
		resourceMetrics: [
			...payload.resourceMetrics,
			...conflicting.resourceMetrics,
		],
	};
	expect((await post(mixed)).status).toBe(404);
	const spoofed = metricExport(
		[
			gauge(`${name}.safe`, [
				stringAttribute("organization_id", otherOrganizationId),
				stringAttribute("project_id", otherProjectId),
			]),
		],
		[stringAttribute("organization_id", otherOrganizationId)],
	);
	expect((await post(spoofed)).status).toBe(200);
	const rows = await stored(name);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		organization_id: organizationId,
		project_id: projectId,
		name: `${name}.safe`,
	});
	expect(await stored(name, otherProjectId)).toHaveLength(0);
	expect(
		(await product(`/v1/metrics?project_id=${otherProjectId}`)).status,
	).toBe(404);
	expect(await read(name, projectId, auth(2))).toHaveLength(1);
	expect(await read(name, otherProjectId, auth(3))).toHaveLength(0);
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
	test(`metrics reject ${variant} Project selectors before normalization or storage`, async () => {
		const name = marker();
		const value: Record<string, unknown> = { stringValue: projectId };
		const selector: Record<string, unknown> = {
			key: "glasshouse.project.id",
			value,
		};
		if (variant.startsWith("attribute-extension")) selector.future = null;
		if (variant.startsWith("value-extension"))
			value.future = { secret: "selector-secret" };
		if (variant === "null-extension") value.future = null;
		if (variant === "conflicting-values") value.boolValue = true;
		if (variant === "malformed-id") value.stringValue = "invalid";
		const selectors = [selector];
		if (variant.endsWith("switch") || variant === "duplicate-identical")
			selectors.push({
				key: "glasshouse.project.id",
				value: {
					stringValue:
						variant === "duplicate-identical" ? projectId : otherProjectId,
				},
			});
		const payload = metricExport([gauge(name)]);
		Object.assign(payload.resourceMetrics[0]!.resource, {
			attributes: selectors,
		});
		expect((await post(payload, projectId, "")).status).toBe(401);
		const response = await post(payload);
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain("selector-secret");
		if (variant === "duplicate-identical" || variant === "malformed-id") {
			const bytes = metricsProtobuf(payload);
			expect(
				(
					await fetch(new URL("/v1/metrics", server.url), {
						method: "POST",
						headers: {
							authorization: auth(),
							"content-type": "application/x-protobuf",
							"x-glasshouse-project-id": projectId,
						},
						body: bytes,
					})
				).status,
			).toBe(400);
			await expect(rpc(bytes)).rejects.toMatchObject({
				code: grpc.status.INVALID_ARGUMENT,
			});
		}
		expect(await stored(name)).toHaveLength(0);
		expect(await stored(name, otherProjectId)).toHaveLength(0);
	});
}

test("metric selectors include empty resources and every repeated query selector", async () => {
	const name = marker();
	const payload = metricExport([gauge(name)]);
	const empty = metricExport(
		[],
		[stringAttribute("glasshouse.project.id", otherProjectId)],
	);
	payload.resourceMetrics.push(...empty.resourceMetrics);
	expect((await post(payload)).status).toBe(404);
	await expect(rpc(metricsProtobuf(payload))).rejects.toMatchObject({
		code: grpc.status.PERMISSION_DENIED,
	});
	for (const key of ["project_id", "filter[project_id]"]) {
		const response = await product(
			`/v1/metrics?${key}=${projectId}&${key}=${otherProjectId}`,
			"POST",
			metricExport([gauge(name)]),
		);
		expect(response.status).toBe(404);
		const withHeader = await fetch(
			new URL(
				`/v1/metrics?${key}=${projectId}&${key}=${otherProjectId}`,
				server.url,
			),
			{
				method: "POST",
				headers: {
					authorization: auth(),
					"content-type": "application/json",
					"x-glasshouse-project-id": projectId,
				},
				body: JSON.stringify(metricExport([gauge(name)])),
			},
		);
		expect(withHeader.status).toBe(404);
	}
	expect(await stored(name)).toHaveLength(0);
	expect(
		(
			await post(
				metricExport(
					[gauge(name)],
					[stringAttribute("glasshouse.project.id", projectId.toUpperCase())],
				),
			)
		).status,
	).toBe(200);
	expect(await stored(name)).toHaveLength(1);
});

test("rotation, revocation and creator role loss reject retries before any later metric is stored", async () => {
	const name = marker();
	const created = await credential(
		projectId,
		durableActorId(accounts[1]!.username),
	);
	const input = {
		organization_id: organizationId,
		project_id: projectId,
		id: created.credential.id,
	};
	const send = (suffix: string, secret: string) =>
		post(
			metricExport([gauge(`${name}.${suffix}`)]),
			projectId,
			`Bearer ${secret}`,
		);
	expect((await send("before", created.secret)).status).toBe(200);
	const rotated = await rotateOtlpCredential(pool, input);
	expect((await send("old", created.secret)).status).toBe(401);
	expect((await send("rotated", rotated.secret)).status).toBe(200);
	await pool.query(
		"UPDATE organization_actor_roles SET role = 'read_only' WHERE organization_id = $1 AND actor_id = $2",
		[organizationId, durableActorId(accounts[1]!.username)],
	);
	try {
		expect((await send("demoted", rotated.secret)).status).toBe(404);
	} finally {
		await pool.query(
			"UPDATE organization_actor_roles SET role = 'user' WHERE organization_id = $1 AND actor_id = $2",
			[organizationId, durableActorId(accounts[1]!.username)],
		);
	}
	await revokeOtlpCredential(pool, input);
	expect((await send("revoked", rotated.secret)).status).toBe(401);
	expect((await stored(name)).map((row) => row.name).sort()).toEqual([
		`${name}.before`,
		`${name}.rotated`,
	]);
});

test("revocation after real Project resolution wins before the metrics storage effect", async () => {
	const name = marker();
	const created = await credential();
	let admitted!: () => void;
	let resume!: () => void;
	const resolved = new Promise<void>((done) => {
		admitted = done;
	});
	const barrier = new Promise<void>((done) => {
		resume = done;
	});
	const app = createApiApp({
		pgPool: () => pool,
		authenticationPool: () => fencePool,
		resolveTenantProject: async (...args) => {
			const tenant = await resolveTenantProject(...args);
			admitted();
			await barrier;
			return tenant;
		},
	});
	const response = app.request("/v1/metrics", {
		method: "POST",
		headers: {
			authorization: `Bearer ${created.secret}`,
			"x-glasshouse-project-id": projectId,
			"content-type": "application/json",
		},
		body: JSON.stringify(metricExport([gauge(name)])),
	});
	try {
		await Promise.race([
			resolved,
			response.then(() => {
				throw new Error("Metrics export returned before Project resolution");
			}),
		]);
		await revokeOtlpCredential(pool, {
			organization_id: organizationId,
			project_id: projectId,
			id: created.credential.id,
		});
	} finally {
		resume();
		await response;
	}
	expect((await response).status).toBe(404);
	expect(await stored(name)).toHaveLength(0);
});

test("gRPC uses the same bearer, trusted Project and revocation controls as HTTP", async () => {
	const name = marker();
	const created = await credential();
	const bytes = metricsProtobuf(metricExport([gauge(name)]));
	const bearer = `Bearer ${created.secret}`;
	await expect(rpc(bytes, "")).rejects.toMatchObject({
		code: grpc.status.UNAUTHENTICATED,
	});
	await expect(rpc(bytes, bearer, otherProjectId)).rejects.toMatchObject({
		code: grpc.status.PERMISSION_DENIED,
	});
	await expect(
		rpc(bytes, bearer, projectId, (md) =>
			md.set("authorization", `${bearer}, ${auth()}`),
		),
	).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
	await expect(
		rpc(bytes, bearer, projectId, (md) =>
			md.add("x-glasshouse-project-id", otherProjectId),
		),
	).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
	expect(decodeMetricsResponse(await rpc(bytes, bearer))).toEqual({});
	await revokeOtlpCredential(pool, {
		organization_id: organizationId,
		project_id: projectId,
		id: created.credential.id,
	});
	await expect(
		rpc(metricsProtobuf(metricExport([gauge(`${name}.revoked`)])), bearer),
	).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
	expect(await stored(name)).toHaveLength(1);
});

test("local session cookies retain precedence/CSRF and disabled creators cannot ingest with an active bearer", async () => {
	const name = marker();
	const credentials = new LocalCredentialStore(pool, organizationId);
	const enrolled = await credentials.provision(adminPrincipal, {
		username: `metric-${randomBytes(6).toString("hex")}`,
		role: "user",
	});
	const pass = password();
	await credentials.enroll(enrolled.token, pass);
	const login = await product("/v1/auth/login", "POST", {
		username: enrolled.username,
		password: pass,
	});
	expect(login.status).toBe(200);
	const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
	const session = await fetch(new URL("/v1/auth/session", server.url), {
		headers: { cookie },
	});
	expect(session.status).toBe(200);
	const { csrf_token } = (await session.json()) as { csrf_token: string };
	const bytes = metricExport([gauge(name)]);
	expect((await post(bytes, projectId, auth(), { cookie })).status).toBe(403);
	expect(
		(
			await post(bytes, projectId, auth(), {
				cookie: "glasshouse_session=invalid",
			})
		).status,
	).toBe(401);
	expect(
		(
			await post(bytes, projectId, "", {
				cookie,
				"x-glasshouse-csrf": csrf_token,
			})
		).status,
	).toBe(200);
	const created = await credential(projectId, enrolled.actorId);
	await credentials.setEnabled(adminPrincipal, enrolled.actorId, false);
	expect(
		(
			await post(
				metricExport([gauge(`${name}.disabled`)]),
				projectId,
				`Bearer ${created.secret}`,
			)
		).status,
	).toBe(401);
	expect(await stored(name)).toHaveLength(1);
});

test("archived Projects reject metric writes without affecting another active Project", async () => {
	const id = await newProject();
	const name = marker();
	expect((await product(`/v1/projects/${id}/archive`, "POST")).status).toBe(
		200,
	);
	expect((await post(metricExport([gauge(name)]), id)).status).toBe(404);
	expect(await stored(name, id)).toHaveLength(0);
	expect((await post(metricExport([gauge(name)]))).status).toBe(200);
	expect(await stored(name)).toHaveLength(1);
});

test("governance metrics retention is approved, bounded, Project-scoped and physically deletes only expired points", async () => {
	const id = await newProject();
	const name = marker();
	const old = (
		BigInt(Date.now() - 10 * 86_400_000) * 1_000_000n +
		123n
	).toString();
	const fresh = (BigInt(Date.now()) * 1_000_000n + 987n).toString();
	const points = [
		old,
		(BigInt(old) + 1n).toString(),
		(BigInt(old) + 2n).toString(),
		fresh,
	].map((timeUnixNano) => ({
		...numberPoint(),
		startTimeUnixNano: (BigInt(timeUnixNano) - 1n).toString(),
		timeUnixNano,
	}));
	const payload = metricExport([{ name, gauge: { dataPoints: points } }]);
	for (const project of [id, projectId])
		expect((await post(payload, project)).status).toBe(200);
	const expiredTrace = randomBytes(16).toString("hex");
	const freshTrace = randomBytes(16).toString("hex");
	for (const project of [id, projectId]) {
		const response = await fetch(new URL("/v1/traces", server.url), {
			method: "POST",
			headers: {
				authorization: auth(),
				"x-glasshouse-project-id": project,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				resourceSpans: [
					{
						scopeSpans: [
							{
								spans: [
									[expiredTrace, old],
									[freshTrace, fresh],
								].map(([traceId, startTimeUnixNano]) => ({
									traceId,
									spanId: randomBytes(8).toString("hex"),
									name: "retention timestamp regression",
									startTimeUnixNano,
									endTimeUnixNano: (
										BigInt(startTimeUnixNano!) + 1_000_000n
									).toString(),
								})),
							},
						],
					},
				],
			}),
		});
		expect(response.status).toBe(200);
	}
	const policy = await product("/v1/governance/policy/drafts", "POST", {
		project_id: id,
		retention: { metrics: 1, traces: 1 },
		redaction: { mode: "none", keys: [] },
	});
	expect(policy.status).toBe(201);
	const { policy: draft } = (await policy.json()) as { policy: { id: string } };
	const preview = () =>
		product("/v1/governance/retention/preview", "POST", { project_id: id });
	// An unapproved draft must not delete or silently become the effective policy.
	const beforeApproval = await preview();
	expect(beforeApproval.status).toBe(200);
	const baseline = (await beforeApproval.json()) as {
		counts: Record<string, number>;
	};
	expect(baseline.counts.metrics ?? 0).toBe(0);
	expect(await stored(name, id)).toHaveLength(4);
	expect(
		(
			await product(
				`/v1/governance/policy/${draft.id}/approve?project_id=${id}`,
				"POST",
			)
		).status,
	).toBe(200);
	const first = await preview();
	expect(first.status).toBe(200);
	const admission = (await first.json()) as {
		preview_id: string;
		policy_version_id: string;
		counts: Record<string, number>;
	};
	expect(admission.counts.metrics).toBe(3);
	const body = {
		project_id: id,
		policy_version_id: admission.policy_version_id,
		preview_id: admission.preview_id,
		batch_size: 2,
	};
	expect(
		(await product("/v1/governance/retention/runs", "POST", body, auth(1)))
			.status,
	).toBe(404);
	const run = await product("/v1/governance/retention/runs", "POST", body);
	expect(run.status).toBe(200);
	expect(await run.json()).toMatchObject({
		status: "completed",
		counts: { metrics: 2 },
	});
	expect(await stored(name, id)).toHaveLength(2);
	const retainedTraces = await clickhouse.query({
		query:
			"SELECT project_id, trace_id FROM traces WHERE organization_id = {organization:String} AND project_id IN {projects:Array(String)} AND trace_id IN {ids:Array(String)} ORDER BY project_id, trace_id",
		query_params: {
			organization: organizationId,
			projects: [id, projectId],
			ids: [expiredTrace, freshTrace],
		},
		format: "JSONEachRow",
	});
	const traceRows = await retainedTraces.json<{
		project_id: string;
		trace_id: string;
	}>();
	expect(traceRows.filter((row) => row.project_id === id)).toEqual([
		{ project_id: id, trace_id: freshTrace },
	]);
	expect(traceRows.filter((row) => row.project_id === projectId)).toHaveLength(
		2,
	);
	expect(
		(await product("/v1/governance/retention/runs", "POST", body)).status,
	).toBe(409);
	const second = (await (await preview()).json()) as typeof admission;
	const finish = await product("/v1/governance/retention/runs", "POST", {
		...body,
		preview_id: second.preview_id,
	});
	expect(finish.status).toBe(200);
	expect(
		(await stored(name, id)).map((row) => row.data_point.timeUnixNano),
	).toEqual([fresh]);
	expect(await stored(name)).toHaveLength(4);
	expect(await read(name, id)).toHaveLength(1);
}, 30_000);

test("metrics retention makes bounded forward progress through 501 identical physical rows with honest reports", async () => {
	const id = await newProject();
	const name = marker();
	const old = (BigInt(Date.now() - 10 * 86_400_000) * 1_000_000n).toString();
	const fresh = (BigInt(Date.now()) * 1_000_000n).toString();
	const payload = metricExport([
		{
			name,
			gauge: { dataPoints: [{ timeUnixNano: old, asInt: "1" }] },
		},
	]);
	expect((await post(payload, id)).status).toBe(200);
	const result = await clickhouse.query({
		query:
			"SELECT * FROM metrics WHERE project_id = {id:String} AND name = {name:String}",
		query_params: { id, name },
		format: "JSONEachRow",
	});
	const [row] = await result.json<Record<string, unknown>>();
	expect(row).toBeDefined();
	await clickhouse.insert({
		table: "metrics",
		format: "JSONEachRow",
		values: [
			...Array.from({ length: 500 }, () => ({ ...row })),
			{
				...row,
				time_unix_nano: fresh,
				data_point: JSON.stringify({ timeUnixNano: fresh, asInt: "1" }),
			},
			{ ...row, organization_id: otherOrganizationId },
			{ ...row, project_id: projectId },
			{
				...row,
				organization_id: otherOrganizationId,
				project_id: otherProjectId,
			},
		],
	});
	await clickhouse.command({ query: "OPTIMIZE TABLE metrics FINAL" });
	const count = async () => {
		const result = await clickhouse.query({
			query:
				"SELECT organization_id, project_id, toString(time_unix_nano) AS time, toString(count()) AS count FROM metrics WHERE name = {name:String} GROUP BY organization_id, project_id, time_unix_nano ORDER BY organization_id, project_id, time_unix_nano",
			query_params: { name },
			format: "JSONEachRow",
		});
		return result.json<{
			organization_id: string;
			project_id: string;
			time: string;
			count: string;
		}>();
	};
	const initial = await count();
	const expired = (rows: Awaited<ReturnType<typeof count>>) =>
		Number(
			rows.find(
				(r) =>
					r.organization_id === organizationId &&
					r.project_id === id &&
					r.time === old,
			)?.count ?? 0,
		);
	const sentinels = (rows: Awaited<ReturnType<typeof count>>) =>
		rows.filter(
			(r) =>
				!(
					r.organization_id === organizationId &&
					r.project_id === id &&
					r.time === old
				),
		);
	expect(initial).toContainEqual({
		organization_id: organizationId,
		project_id: id,
		time: old,
		count: "501",
	});
	expect(expired(initial)).toBe(501);
	await approveMetricRetention(id);
	for (const expected of [500, 1, 0]) {
		const before = await count();
		const admission = await metricRetentionPreview(id);
		expect(admission.counts.metrics).toBe(expired(before));
		const run = await product("/v1/governance/retention/runs", "POST", {
			project_id: id,
			preview_id: admission.preview_id,
			policy_version_id: admission.policy_version_id,
			batch_size: 500,
		});
		expect(run.status).toBe(200);
		const report = (await run.json()) as {
			run_id: string;
			status: string;
			counts: { metrics: number };
		};
		expect(report).toMatchObject({
			status: "completed",
			counts: { metrics: expected },
		});
		const after = await count();
		expect(expired(before) - expired(after)).toBe(report.counts.metrics);
		expect(sentinels(after)).toEqual(sentinels(initial));
		const evidence = await pool.query(
			"SELECT status, counts FROM governance_retention_runs WHERE id = $1",
			[report.run_id],
		);
		expect(evidence.rows).toEqual([
			{ status: "completed", counts: { metrics: expected } },
		]);
		const audit = await pool.query(
			"SELECT counts FROM governance_audit_events WHERE project_id = $1 AND event_type = 'retention_completed' ORDER BY created_at DESC LIMIT 1",
			[id],
		);
		expect(audit.rows).toEqual([{ counts: { metrics: expected } }]);
	}
}, 30_000);

for (const { mergeAttempts, partial } of [
	{ mergeAttempts: 1, partial: false },
	{ mergeAttempts: 3, partial: false },
	{ mergeAttempts: 1, partial: true },
]) {
	test(`metrics retention holds the Project fence and reports real progress after ${mergeAttempts} part changes (partial=${partial})`, async () => {
		const id = await newProject();
		const name = marker();
		const old = (BigInt(Date.now() - 10 * 86_400_000) * 1_000_000n).toString();
		const older = (
			BigInt(Date.now() - 40 * 86_400_000) * 1_000_000n
		).toString();
		expect(
			(
				await post(
					metricExport([
						{
							name,
							gauge: {
								dataPoints: Array.from({ length: 3 }, (_, i) => ({
									timeUnixNano: partial && i === 0 ? older : old,
									asInt: "1",
								})),
							},
						},
					]),
					id,
				)
			).status,
		).toBe(200);
		await approveMetricRetention(id);
		const admission = await metricRetentionPreview(id);
		expect(admission.counts.metrics).toBe(3);
		const body = {
			project_id: id,
			preview_id: admission.preview_id,
			policy_version_id: admission.policy_version_id,
			batch_size: 2,
		};
		const probe = await pool.connect();
		const assertProjectLocked = async () => {
			await expect(
				probe.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE NOWAIT", [
					id,
				]),
			).rejects.toMatchObject({ code: "55P03" });
			expect(
				(
					await probe.query(
						"SELECT id FROM projects WHERE id = $1 FOR UPDATE NOWAIT",
						[otherProjectId],
					)
				).rows,
			).toEqual([{ id: otherProjectId }]);
		};
		const realQuery = clickhouse.query.bind(clickhouse);
		let selections = 0;
		const query = spyOn(clickhouse, "query").mockImplementation(
			async (params) => {
				if (
					(params.query.startsWith("SELECT _part AS part") ||
						params.query.startsWith("SELECT toString(count()) AS count")) &&
					params.query_params?.projectId === id
				) {
					if (params.query.startsWith("SELECT _part AS part")) selections++;
					await assertProjectLocked();
				}
				return realQuery(params);
			},
		);
		const realCommand = clickhouse.command.bind(clickhouse);
		let mutations = 0;
		const command = spyOn(clickhouse, "command").mockImplementation(
			async (params) => {
				if (
					params.query.startsWith("ALTER TABLE metrics DELETE") &&
					params.query_params?.projectId === id
				) {
					mutations++;
					await assertProjectLocked();
					if (mutations <= mergeAttempts) {
						// Rewrite only this suite's owned disposable table, never a shared store.
						await realCommand({
							query: `OPTIMIZE TABLE metrics ${partial ? "PARTITION {partition:UInt64}" : ""} FINAL SETTINGS optimize_skip_merged_partitions = 0`,
							query_params: {
								partition: (BigInt(old) / 2_592_000_000_000_000n).toString(),
							},
						});
						const response = await realCommand(params);
						expect(await stored(name, id)).toHaveLength(partial ? 2 : 3);
						return response;
					}
				}
				return realCommand(params);
			},
		);
		try {
			const response = await product(
				"/v1/governance/retention/runs",
				"POST",
				body,
			);
			expect(response.status).toBe(mergeAttempts === 1 ? 200 : 500);
			expect(selections).toBe(partial ? 1 : mergeAttempts === 1 ? 2 : 3);
			expect(mutations).toBe(selections);
			const report = await pool.query(
				"SELECT status, counts FROM governance_retention_runs WHERE project_id = $1",
				[id],
			);
			expect(report.rows).toEqual(
				mergeAttempts === 1
					? [{ status: "completed", counts: { metrics: partial ? 1 : 2 } }]
					: [{ status: "failed", counts: {} }],
			);
			expect(await stored(name, id)).toHaveLength(
				partial ? 2 : mergeAttempts === 1 ? 1 : 3,
			);
		} finally {
			command.mockRestore();
			query.mockRestore();
			probe.release();
		}
		if (mergeAttempts === 3) {
			const next = await metricRetentionPreview(id);
			const retry = await product("/v1/governance/retention/runs", "POST", {
				...body,
				preview_id: next.preview_id,
			});
			expect(retry.status).toBe(200);
			expect(await retry.json()).toMatchObject({
				status: "completed",
				counts: { metrics: 2 },
			});
			expect(await stored(name, id)).toHaveLength(1);
		}
	}, 30_000);
}

test("Project deletion removes physical metrics and rejects credential replay while preserving another tenant", async () => {
	const id = await newProject();
	const name = marker();
	const created = await credential(id);
	const payload = metricExport([gauge(name)]);
	expect((await post(payload, id, `Bearer ${created.secret}`)).status).toBe(
		200,
	);
	expect((await post(payload, otherProjectId, auth(3))).status).toBe(200);
	expect(
		(
			await product(`/v1/projects/${id}`, "DELETE", {
				confirmation_name: "Metrics disposable",
			})
		).status,
	).toBe(204);
	expect(await stored(name, id)).toHaveLength(0);
	expect(await stored(name, otherProjectId)).toHaveLength(1);
	expect((await post(payload, id, `Bearer ${created.secret}`)).status).toBe(
		401,
	);
	expect((await product(`/v1/metrics?project_id=${id}`)).status).toBe(404);
	const job = await pool.query(
		"SELECT status FROM project_deletion_jobs WHERE organization_id = $1 AND project_id = $2",
		[organizationId, id],
	);
	expect(job.rows).toEqual([{ status: "completed" }]);
	expect(
		(
			await pool.query(
				"SELECT 1 FROM project_metric_identity_keys WHERE project_id = $1",
				[id],
			)
		).rows,
	).toHaveLength(0);
}, 30_000);

test("Project deletion retry clears metrics even with both legacy ClickHouse checkpoints already complete", async () => {
	const id = await newProject();
	const name = marker();
	expect((await post(metricExport([gauge(name)]), id)).status).toBe(200);
	await pool.query("UPDATE projects SET status = 'deleting' WHERE id = $1", [
		id,
	]);
	await pool.query(
		"INSERT INTO project_deletion_jobs (organization_id, project_id, requested_by, status, traces_cleaned_at, observations_cleaned_at, attempt_count) VALUES ($1, $2, $3, 'failed', now(), now(), 1)",
		[organizationId, id, `basic:${accounts[0]!.username}`],
	);
	expect(
		(
			await product(`/v1/projects/${id}`, "DELETE", {
				confirmation_name: "Metrics disposable",
			})
		).status,
	).toBe(204);
	expect(await stored(name, id)).toHaveLength(0);
	expect(
		(
			await pool.query(
				"SELECT status, attempt_count FROM project_deletion_jobs WHERE project_id = $1",
				[id],
			)
		).rows,
	).toEqual([{ status: "completed", attempt_count: 2 }]);
}, 30_000);

test("official protobuf metadata is retained/redacted through HTTP and gRPC rather than silently dropped", async () => {
	const name = marker();
	const child = Bun.spawn(
		[
			process.env.OTLP_METRICS_SDK_PYTHON ?? "python3",
			resolve(import.meta.dir, "../fixtures/otlp-metrics-sdk.py"),
		],
		{
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				PYTHONNOUSERSITE: "1",
				METRICS_TEST_PROTO_METADATA: "1",
				METRICS_TEST_PREFIX: name,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const deadline = setTimeout(() => child.kill(), 10_000);
	const [bytes, error, exitCode] = await Promise.all([
		new Response(child.stdout).arrayBuffer(),
		new Response(child.stderr).text(),
		child.exited,
	]).finally(() => clearTimeout(deadline));
	expect({ error, exitCode }).toEqual({ error: "", exitCode: 0 });
	const response = await fetch(new URL("/v1/metrics", server.url), {
		method: "POST",
		headers: {
			authorization: auth(),
			"x-glasshouse-project-id": projectId,
			"content-type": "application/x-protobuf",
		},
		body: bytes,
	});
	expect(response.status).toBe(200);
	expect(decodeMetricsResponse(await rpc(Buffer.from(bytes)))).toEqual({});
	const rows = (await read(name)) as (MetricRow & {
		metric_metadata: unknown[];
	})[];
	expect(rows).toHaveLength(1);
	expect(rows[0]!.metric_metadata).toEqual([
		stringAttribute("safe", "metadata-retained"),
	]);
	expect(JSON.stringify(rows)).not.toContain("metadata-sensitive");
});

for (const transport of ["http", "grpc"]) {
	test(`official Python SDK ${transport} exporter succeeds only after metrics are stored and readable`, async () => {
		const name = marker();
		const created = await credential();
		const child = Bun.spawn(
			[
				process.env.OTLP_METRICS_SDK_PYTHON ?? "python3",
				resolve(import.meta.dir, "../fixtures/otlp-metrics-sdk.py"),
			],
			{
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					PYTHONNOUSERSITE: "1",
					METRICS_TEST_HTTP_ENDPOINT: server.url.origin,
					METRICS_TEST_GRPC_ENDPOINT: grpcEndpoint,
					METRICS_TEST_PROJECT_ID: projectId,
					METRICS_TEST_AUTHORIZATION: `Bearer ${created.secret}`,
					METRICS_TEST_TRANSPORT: transport,
					METRICS_TEST_PREFIX: name,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const deadline = setTimeout(() => child.kill(), 20_000);
		const [output, error, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]).finally(() => clearTimeout(deadline));
		expect({ exitCode, error }).toEqual({ exitCode: 0, error: "" });
		const expected = JSON.parse(output) as {
			name: string;
			time: string;
			value?: number;
			count?: string;
			sum?: number;
			buckets?: string[];
			bounds?: number[];
			temporality?: number;
		}[];
		expect(expected).toHaveLength(4);
		const rows = await stored(name);
		expect(rows).toHaveLength(4);
		expect(await read(name)).toHaveLength(4);
		for (const item of expected) {
			const row = rows.find((row) => row.name === item.name)!;
			expect(row).toBeDefined();
			expect(row.data_point.timeUnixNano).toBe(item.time);
			expect(row.scope_name).toBe("glasshouse.metrics.sdk");
			if (item.temporality !== undefined)
				expect(row.aggregation_temporality).toBe(item.temporality);
			expect(row.resource_attributes).toContainEqual(
				stringAttribute("service.name", "glasshouse-metrics-sdk-regression"),
			);
			expect(row.data_point.attributes).toContainEqual({
				key: "sdk.enabled",
				value: { boolValue: false },
			});
			if (item.count !== undefined) {
				expect(row.data_point).toMatchObject({
					count: item.count,
					sum: item.sum,
					bucketCounts: item.buckets,
					explicitBounds: item.bounds,
				});
			} else expect(row.data_point.asInt).toBe(String(item.value));
		}
	}, 30_000);
}
