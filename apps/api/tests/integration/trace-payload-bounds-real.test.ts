import { afterAll, describe, expect, it } from "bun:test";
import { createClient } from "@clickhouse/client";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApiApp } from "../../src/index.js";
import { clickhouseUrl } from "../../src/db/clickhouse.js";
import {
	MAX_RETAINED_TEXT_BYTES,
	MAX_TRACE_RESPONSE_BYTES,
} from "../../src/db/trace-payload-bounds.js";
import { sseMaxPendingBytes } from "../../src/lib/authorized-sse.js";
import { bootstrapAuthorization } from "../../src/db/bootstrap-authorization.js";

const encoder = new TextEncoder();
const marker = `trace-bounds-${randomBytes(8).toString("hex")}`;
const traceIds = [
	randomBytes(16).toString("hex"),
	randomBytes(16).toString("hex"),
	randomBytes(16).toString("hex"),
];
const organizationId = randomUUID();
const projectId = randomUUID();
const credential = {
	username: `trace-bounds-${randomBytes(8).toString("hex")}`,
	password: randomBytes(24).toString("base64url"),
	organization_id: organizationId,
};
const client = createClient({
	url: clickhouseUrl(),
	database: process.env.CLICKHOUSE_DB ?? "astraea",
	username: process.env.CLICKHOUSE_USER ?? "astraea",
	password: process.env.CLICKHOUSE_PASSWORD ?? "",
});
const pg = new Pool({ connectionString: process.env.DATABASE_URL });

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let authorization: string;

function bytes(value: unknown): number {
	return encoder.encode(JSON.stringify(value)).byteLength;
}

function span(traceId: string, index: number) {
	return {
		trace_id: traceId,
		span_id: (index + 1).toString(16).padStart(16, "0"),
		name: marker,
		start_time_unix_nano: String(1_700_000_000_000_000_000 + index * 1_000_000),
		end_time_unix_nano: String(1_700_000_000_100_000_000 + index * 1_000_000),
		attributes: [
			{ key: "gen_ai.system", value: { stringValue: "openai" } },
			{
				key: "gen_ai.prompt.0.content",
				value: { stringValue: "a".repeat(MAX_RETAINED_TEXT_BYTES + 1) },
			},
			{
				key: "gen_ai.completion.0.content",
				value: { stringValue: "界".repeat(2_731) },
			},
		],
	};
}

async function request(path: string, init: RequestInit = {}) {
	return fetch(`${baseUrl}${path}`, {
		...init,
		headers: {
			authorization,
			...init.headers,
		},
	});
}

async function readSseUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	event: string,
): Promise<Record<string, unknown>> {
	let buffered = "";
	for (;;) {
		const result = await reader.read();
		expect(result.done).toBe(false);
		buffered += new TextDecoder().decode(result.value, { stream: true });
		let boundary: number;
		while ((boundary = buffered.indexOf("\n\n")) >= 0) {
			const frame = buffered.slice(0, boundary);
			buffered = buffered.slice(boundary + 2);
			if (!frame.startsWith(`event: ${event}\n`)) continue;
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => line.slice("data: ".length))
				.join("\n");
			return JSON.parse(data) as Record<string, unknown>;
		}
	}
}

afterAll(async () => {
	server?.stop(true);
	await client.close();
	await pg.end();
});

describe("real OTLP retained trace bounds", () => {
	it("persists bounded UTF-8 fields and exposes every REST and SSE continuation page", async () => {
		await pg.query(
			`WITH organization AS (
				INSERT INTO organizations (id, name, slug, default_project_id)
				VALUES ($1, $2, $3, $4)
				RETURNING id
			)
			INSERT INTO projects (id, organization_id, name, slug)
			SELECT $4, id, 'Default Project', 'default'
			FROM organization`,
			[organizationId, marker, marker, projectId],
		);
		const bootstrapEnv = {
			...process.env,
			ASTRAEA_BASIC_AUTH_CREDENTIALS: JSON.stringify([credential]),
			ASTRAEA_BOOTSTRAP_OWNER_USERNAME: credential.username,
		};
		await bootstrapAuthorization(bootstrapEnv);
		authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
		const configuredCredentials = process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS;
		process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS = JSON.stringify([credential]);
		try {
			server = Bun.serve({ port: 0, fetch: createApiApp().fetch });
		} finally {
			if (configuredCredentials === undefined)
				delete process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS;
			else process.env.ASTRAEA_BASIC_AUTH_CREDENTIALS = configuredCredentials;
		}
		baseUrl = server.url.toString().replace(/\/$/, "");

		const spans = [
			...Array.from({ length: 15 }, (_, index) => span(traceIds[0]!, index)),
			span(traceIds[1]!, 100),
			span(traceIds[2]!, 200),
		];
		const ingest = await request("/v1/otel/v1/traces", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-astraea-project-id": projectId,
			},
			body: JSON.stringify({
				resource_spans: [
					{
						resource: { attributes: [] },
						scope_spans: [{ scope: { name: marker }, spans }],
					},
				],
			}),
		});
		expect(ingest.status).toBe(200);

		const stored = await client.query({
			query:
				"SELECT input_text, output_text, input_retained_truncated, output_retained_truncated FROM observations WHERE trace_id = {trace_id: String} AND project_id = {project_id: String} ORDER BY observation_id",
			query_params: { trace_id: traceIds[0]!, project_id: projectId },
			format: "JSONEachRow",
		});
		const storedRows = (await stored.json()) as Array<{
			input_text: string;
			output_text: string;
			input_retained_truncated: boolean;
			output_retained_truncated: boolean;
		}>;
		expect(storedRows).toHaveLength(15);
		for (const row of storedRows) {
			expect(encoder.encode(row.input_text).byteLength).toBe(
				MAX_RETAINED_TEXT_BYTES,
			);
			expect(encoder.encode(row.output_text).byteLength).toBeLessThanOrEqual(
				MAX_RETAINED_TEXT_BYTES,
			);
			expect(row.input_retained_truncated).toBe(true);
			expect(row.output_retained_truncated).toBe(true);
		}

		let traceCursor: string | undefined;
		const listedTraceIds: string[] = [];
		do {
			const response = await request(
				`/v1/traces?project_id=${projectId}&filter[name]=${marker}&limit=1${traceCursor ? `&cursor=${traceCursor}` : ""}`,
			);
			expect(response.status).toBe(200);
			const page = (await response.json()) as {
				items: Array<{
					trace_id: string;
					input_text: string;
					input_retained_truncated?: boolean;
					output_retained_truncated?: boolean;
					input_excerpt_truncated?: boolean;
				}>;
				next_cursor?: string;
			};
			expect(bytes(page)).toBeLessThanOrEqual(MAX_TRACE_RESPONSE_BYTES);
			for (const trace of page.items) {
				listedTraceIds.push(trace.trace_id);
				expect(trace.input_text).toHaveLength(200);
				expect(trace.input_retained_truncated).toBe(true);
				expect(trace.output_retained_truncated).toBe(true);
				expect(trace.input_excerpt_truncated).toBe(true);
			}
			traceCursor = page.next_cursor;
		} while (traceCursor);
		expect(new Set(listedTraceIds)).toEqual(new Set(traceIds));

		let detailCursor: string | undefined;
		const detailObservationIds: string[] = [];
		do {
			const response = await request(
				`/v1/traces/${traceIds[0]}?project_id=${projectId}${detailCursor ? `&cursor=${detailCursor}` : ""}`,
			);
			expect(response.status).toBe(200);
			const page = (await response.json()) as {
				observations: Array<{
					observation_id: string;
					input_text: string;
					output_text: string;
					input_retained_truncated?: boolean;
					output_retained_truncated?: boolean;
				}>;
				next_cursor?: string;
			};
			expect(bytes(page)).toBeLessThanOrEqual(MAX_TRACE_RESPONSE_BYTES);
			for (const observation of page.observations) {
				detailObservationIds.push(observation.observation_id);
				expect(encoder.encode(observation.input_text).byteLength).toBe(
					MAX_RETAINED_TEXT_BYTES,
				);
				expect(
					encoder.encode(observation.output_text).byteLength,
				).toBeLessThanOrEqual(MAX_RETAINED_TEXT_BYTES);
				expect(observation.input_retained_truncated).toBe(true);
				expect(observation.output_retained_truncated).toBe(true);
			}
			detailCursor = page.next_cursor;
		} while (detailCursor);
		expect(detailObservationIds).toHaveLength(15);
		expect(new Set(detailObservationIds).size).toBe(15);

		const events = await request(
			`/v1/traces/${traceIds[0]}/events?project_id=${projectId}`,
		);
		expect(events.status).toBe(200);
		const reader = events.body!.getReader();
		try {
			const snapshot = await readSseUntil(reader, "snapshot");
			expect(bytes(snapshot)).toBeLessThanOrEqual(sseMaxPendingBytes());
			expect(snapshot.snapshot_truncated).toBe(true);
			expect(snapshot.next_cursor).toEqual(expect.any(String));
			const snapshotObservations = snapshot.observations as Array<{
				input_retained_truncated?: boolean;
				output_retained_truncated?: boolean;
			}>;
			expect(snapshotObservations.length).toBeGreaterThan(0);
			expect(snapshotObservations.length).toBeLessThan(7);
			for (const observation of snapshotObservations) {
				expect(observation.input_retained_truncated).toBe(true);
				expect(observation.output_retained_truncated).toBe(true);
			}

			const liveIngest = await request("/v1/otel/v1/traces", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-astraea-project-id": projectId,
				},
				body: JSON.stringify({
					resource_spans: [
						{
							resource: { attributes: [] },
							scope_spans: [
								{ scope: { name: marker }, spans: [span(traceIds[0]!, 300)] },
							],
						},
					],
				}),
			});
			expect(liveIngest.status).toBe(200);
			const live = await readSseUntil(reader, "observation");
			expect(bytes(live)).toBeLessThanOrEqual(sseMaxPendingBytes());
			const liveObservation = live.observation as {
				input_retained_truncated?: boolean;
				output_retained_truncated?: boolean;
			};
			expect(liveObservation.input_retained_truncated).toBe(true);
			expect(liveObservation.output_retained_truncated).toBe(true);
		} finally {
			await reader.cancel();
		}
	});
});
