import { afterAll, describe, expect, it } from "bun:test";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createApiApp } from "../../src/index.js";
import {
	clickhouseUrl,
	closeClickHouseClient,
} from "../../src/db/clickhouse.js";
import { applyClickHouseMigrations } from "../../src/db/clickhouse-migrate.js";
import {
	MAX_RETAINED_TEXT_BYTES,
	MAX_TRACE_RESPONSE_BYTES,
} from "../../src/db/trace-payload-bounds.js";
import { bootstrapAuthorization } from "../../src/db/bootstrap-authorization.js";

const encoder = new TextEncoder();
const database = `legacy_trace_upgrade_${randomBytes(8).toString("hex")}`;
const organizationId = randomUUID();
const projectId = randomUUID();
const traceId = randomBytes(16).toString("hex");
const observationId = randomBytes(16).toString("hex");
const username = `legacy-trace-${randomBytes(8).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const credential = { username, password, organization_id: organizationId };
const legacyText = "界".repeat(3_000);
const previousDatabase = process.env.CLICKHOUSE_DB;
const previousCredentials = process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
const admin = createClient({
	url: clickhouseUrl(),
	database: "default",
	username: process.env.CLICKHOUSE_USER ?? "glasshouse",
	password: process.env.CLICKHOUSE_PASSWORD ?? "",
});
const pg = new Pool({ connectionString: process.env.DATABASE_URL });

let fixture: ClickHouseClient | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

async function applyBeforePayloadBounds(client: ClickHouseClient) {
	for (const file of [
		"0001_traces.sql",
		"0002_observations.sql",
		"0003_organization_tenancy.sql",
		"0004_otlp_insert_deduplication.sql",
		"0005_required_tenant_scope.sql",
	]) {
		const source = await readFile(
			fileURLToPath(
				new URL(`../../../../infra/db/clickhouse/${file}`, import.meta.url),
			),
			"utf8",
		);
		for (const query of source
			.replace(/^--.*$/gm, "")
			.split(";")
			.map((statement) => statement.trim())
			.filter(Boolean))
			await client.command({ query });
	}
}

async function readSnapshotFrame(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ frame: string; data: Record<string, unknown> }> {
	let buffered = "";
	for (;;) {
		const result = await reader.read();
		expect(result.done).toBe(false);
		buffered += new TextDecoder().decode(result.value, { stream: true });
		const boundary = buffered.indexOf("\n\n");
		if (boundary < 0) continue;
		const frame = buffered.slice(0, boundary);
		buffered = buffered.slice(boundary + 2);
		if (!frame.startsWith("event: snapshot\n")) continue;
		const data = frame
			.split("\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.slice("data: ".length))
			.join("\n");
		return { frame, data: JSON.parse(data) as Record<string, unknown> };
	}
}

afterAll(async () => {
	server?.stop(true);
	if (previousDatabase === undefined) delete process.env.CLICKHOUSE_DB;
	else process.env.CLICKHOUSE_DB = previousDatabase;
	if (previousCredentials === undefined)
		delete process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
	else process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = previousCredentials;
	await closeClickHouseClient();
	await fixture?.close();
	await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` });
	await admin.close();
	await pg.end();
});

describe("legacy pre-0006 trace payload upgrade", () => {
	it("keeps historical multibyte rows untouched while REST and raw SSE materialize bounded text", async () => {
		await admin.command({ query: `CREATE DATABASE ${database}` });
		fixture = createClient({
			url: clickhouseUrl(),
			database,
			username: process.env.CLICKHOUSE_USER ?? "glasshouse",
			password: process.env.CLICKHOUSE_PASSWORD ?? "",
		});
		await applyBeforePayloadBounds(fixture);
		await fixture.insert({
			table: "traces",
			format: "JSONEachRow",
			values: [
				{
					trace_id: traceId,
					organization_id: organizationId,
					project_id: projectId,
					name: "legacy payload",
					start_time: "2026-09-13 00:00:00.000",
					end_time: null,
					duration_ms: null,
					status: "ok",
					user_id: "",
					session_id: "",
					agent_id: "",
					agent_version: "",
					env: "test",
					tags: [],
					input_text: legacyText,
					output_text: legacyText,
					scores_summary: "",
					metadata: "",
				},
			],
		});
		await fixture.insert({
			table: "observations",
			format: "JSONEachRow",
			values: [
				{
					observation_id: observationId,
					trace_id: traceId,
					organization_id: organizationId,
					project_id: projectId,
					parent_observation_id: null,
					type: "span",
					name: "legacy payload",
					start_time: "2026-09-13 00:00:00.000",
					end_time: null,
					duration_ms: null,
					status: "ok",
					model: null,
					input_text: legacyText,
					output_text: legacyText,
					metadata: JSON.stringify({
						schema_version: 1,
						attributes: [],
						prompt_provenance: null,
					}),
				},
			],
		});
		await applyClickHouseMigrations(
			createClient({
				url: clickhouseUrl(),
				database,
				username: process.env.CLICKHOUSE_USER ?? "glasshouse",
				password: process.env.CLICKHOUSE_PASSWORD ?? "",
			}),
		);

		const retained = await fixture.query({
			query:
				"SELECT length(input_text) AS bytes, input_retained_truncated FROM observations WHERE trace_id = {trace_id: String}",
			query_params: { trace_id: traceId },
			format: "JSONEachRow",
		});
		expect(await retained.json()).toEqual([
			{ bytes: String(legacyText.length * 3), input_retained_truncated: false },
		]);

		await pg.query(
			`WITH organization AS (
				INSERT INTO organizations (id, name, slug, default_project_id)
				VALUES ($1, $2, $3, $4)
				RETURNING id
			)
			INSERT INTO projects (id, organization_id, name, slug)
			SELECT $4, id, 'Default Project', 'default' FROM organization`,
			[organizationId, username, username, projectId],
		);
		await bootstrapAuthorization({
			...process.env,
			GLASSHOUSE_BASIC_AUTH_CREDENTIALS: JSON.stringify([credential]),
			GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME: username,
		});
		process.env.CLICKHOUSE_DB = database;
		process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = JSON.stringify([
			credential,
		]);
		server = Bun.serve({ port: 0, fetch: createApiApp().fetch });
		const baseUrl = server.url.toString().replace(/\/$/, "");
		const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

		const detail = await fetch(
			`${baseUrl}/v1/traces/${traceId}?project_id=${projectId}`,
			{ headers: { authorization } },
		);
		const rawDetail = await detail.text();
		expect(detail.status).toBe(200);
		expect(encoder.encode(rawDetail).byteLength).toBeLessThanOrEqual(
			MAX_TRACE_RESPONSE_BYTES,
		);
		const observation = (
			JSON.parse(rawDetail) as { observations: Array<Record<string, unknown>> }
		).observations[0]!;
		expect(
			encoder.encode(observation.input_text as string).byteLength,
		).toBeLessThanOrEqual(MAX_RETAINED_TEXT_BYTES);
		expect(observation.input_retained_truncated).toBe(true);
		expect(observation.output_retained_truncated).toBe(true);

		const events = await fetch(
			`${baseUrl}/v1/traces/${traceId}/events?project_id=${projectId}`,
			{ headers: { authorization } },
		);
		expect(events.status).toBe(200);
		const reader = events.body!.getReader();
		try {
			const snapshot = await readSnapshotFrame(reader);
			expect(
				encoder.encode(`${snapshot.frame}\n\n`).byteLength,
			).toBeLessThanOrEqual(MAX_TRACE_RESPONSE_BYTES);
			const streamed = (
				snapshot.data.observations as Array<Record<string, unknown>>
			)[0]!;
			expect(
				encoder.encode(streamed.input_text as string).byteLength,
			).toBeLessThanOrEqual(MAX_RETAINED_TEXT_BYTES);
			expect(streamed.input_retained_truncated).toBe(true);
		} finally {
			await reader.cancel();
		}
	});
});
