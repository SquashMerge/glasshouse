import { afterAll, describe, expect, it } from "bun:test";
import { createClient } from "@clickhouse/client";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createApiApp } from "../../src/index.js";
import { clickhouseUrl } from "../../src/db/clickhouse.js";
import {
	MAX_RETAINED_TEXT_BYTES,
	MAX_RETAINED_METADATA_BYTES,
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

const exactInput = "a".repeat(MAX_RETAINED_TEXT_BYTES);
const exactOutput = `${"界".repeat(2_730)}aa`;
const metadataFirstValue = "a".repeat(MAX_RETAINED_TEXT_BYTES);
const metadataSecondValue = "a".repeat(
	MAX_RETAINED_METADATA_BYTES -
		bytes({
			schema_version: 1,
			attributes: [
				{ key: "metadata.first", value: { stringValue: metadataFirstValue } },
				{ key: "metadata.second", value: { stringValue: "" } },
			],
		}),
);

function span(traceId: string, index: number, exact = false) {
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
				value: {
					stringValue: exact
						? exactInput
						: "a".repeat(MAX_RETAINED_TEXT_BYTES + 1),
				},
			},
			{
				key: "gen_ai.completion.0.content",
				value: {
					stringValue: exact ? exactOutput : "界".repeat(2_731),
				},
			},
		],
	};
}

function metadataSpan(traceId: string, index: number, overLimit: boolean) {
	return {
		trace_id: traceId,
		span_id: (index + 1).toString(16).padStart(16, "0"),
		name: marker,
		start_time_unix_nano: String(1_700_000_000_000_000_000 + index * 1_000_000),
		end_time_unix_nano: String(1_700_000_000_100_000_000 + index * 1_000_000),
		attributes: [
			{ key: "metadata.first", value: { stringValue: metadataFirstValue } },
			{
				key: "metadata.second",
				value: { stringValue: `${metadataSecondValue}${overLimit ? "a" : ""}` },
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
			span(traceIds[1]!, 100, true),
			metadataSpan(traceIds[2]!, 200, false),
			metadataSpan(traceIds[3]!, 300, true),
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

		const storedTraces = await client.query({
			query:
				"SELECT trace_id, input_text, output_text, input_retained_truncated, output_retained_truncated FROM traces WHERE trace_id IN ({over_limit: String}, {exact: String}) AND project_id = {project_id: String}",
			query_params: {
				over_limit: traceIds[0]!,
				exact: traceIds[1]!,
				project_id: projectId,
			},
			format: "JSONEachRow",
		});
		const traceRows = (await storedTraces.json()) as Array<{
			trace_id: string;
			input_text: string;
			output_text: string;
			input_retained_truncated: boolean;
			output_retained_truncated: boolean;
		}>;
		expect(
			traceRows.filter((row) => row.trace_id === traceIds[0]),
		).toHaveLength(1);
		for (const row of traceRows) {
			const exact = row.trace_id === traceIds[1];
			expect(encoder.encode(row.input_text).byteLength).toBe(
				MAX_RETAINED_TEXT_BYTES,
			);
			expect(encoder.encode(row.output_text).byteLength).toBe(
				exact ? MAX_RETAINED_TEXT_BYTES : MAX_RETAINED_TEXT_BYTES - 2,
			);
			expect(row.input_retained_truncated).toBe(!exact);
			expect(row.output_retained_truncated).toBe(!exact);
		}

		const storedMetadata = await client.query({
			query:
				"SELECT trace_id, metadata FROM observations WHERE trace_id IN ({exact: String}, {over_limit: String}) AND project_id = {project_id: String}",
			query_params: {
				exact: traceIds[2]!,
				over_limit: traceIds[3]!,
				project_id: projectId,
			},
			format: "JSONEachRow",
		});
		const metadataRows = (await storedMetadata.json()) as Array<{
			trace_id: string;
			metadata: string;
		}>;
		expect(metadataRows).toHaveLength(2);
		for (const row of metadataRows) {
			const metadata = JSON.parse(row.metadata) as {
				attributes: unknown[];
				truncated?: boolean;
			};
			const overLimit = row.trace_id === traceIds[3];
			expect(metadata.attributes).toHaveLength(overLimit ? 1 : 2);
			if (!overLimit) {
				expect(encoder.encode(row.metadata).byteLength).toBe(
					MAX_RETAINED_METADATA_BYTES,
				);
			}
			expect(encoder.encode(row.metadata).byteLength).toBeLessThanOrEqual(
				MAX_RETAINED_METADATA_BYTES,
			);
			expect(metadata.truncated === true).toBe(overLimit);
		}

		let traceCursor: string | undefined;
		const listedTraceIds: string[] = [];
		do {
			const response = await request(
				`/v1/traces?project_id=${projectId}&filter[name]=${marker}&limit=1${traceCursor ? `&cursor=${traceCursor}` : ""}`,
			);
			expect(response.status).toBe(200);
			const raw = await response.text();
			const page = JSON.parse(raw) as {
				items: Array<{
					trace_id: string;
					input_text: string;
					output_text: string;
					input_retained_truncated?: boolean;
					output_retained_truncated?: boolean;
					input_excerpt_truncated?: boolean;
				}>;
				next_cursor?: string;
			};
			expect(encoder.encode(raw).byteLength).toBeLessThanOrEqual(
				MAX_TRACE_RESPONSE_BYTES,
			);
			for (const trace of page.items) {
				listedTraceIds.push(trace.trace_id);
				if (trace.trace_id === traceIds[0]) {
					expect(trace.input_text).toHaveLength(200);
					expect(trace.input_retained_truncated).toBe(true);
					expect(trace.output_retained_truncated).toBe(true);
					expect(trace.input_excerpt_truncated).toBe(true);
				} else if (trace.trace_id === traceIds[1]) {
					expect(trace.input_text).toHaveLength(200);
					expect(trace.input_retained_truncated).toBeUndefined();
					expect(trace.output_retained_truncated).toBeUndefined();
					expect(trace.input_excerpt_truncated).toBe(true);
				} else {
					expect(trace.input_text).toBe("");
					expect(trace.output_text).toBe("");
				}
			}
			traceCursor = page.next_cursor;
		} while (traceCursor);
		expect(new Set(listedTraceIds)).toEqual(new Set(traceIds));

		let observationCursor: string | undefined;
		const listedObservationIds: string[] = [];
		do {
			const response = await request(
				`/v1/observations?project_id=${projectId}&filter[name]=${marker}&limit=1${observationCursor ? `&cursor=${observationCursor}` : ""}`,
			);
			expect(response.status).toBe(200);
			const raw = await response.text();
			const page = JSON.parse(raw) as {
				items: Array<{
					observation_id: string;
					input_text: string;
					output_text: string;
					metadata_truncated?: boolean;
				}>;
				next_cursor?: string;
			};
			expect(encoder.encode(raw).byteLength).toBeLessThanOrEqual(
				MAX_TRACE_RESPONSE_BYTES,
			);
			for (const observation of page.items) {
				listedObservationIds.push(observation.observation_id);
			}
			observationCursor = page.next_cursor;
		} while (observationCursor);
		expect(listedObservationIds).toHaveLength(spans.length);
		expect(new Set(listedObservationIds).size).toBe(spans.length);

		let detailCursor: string | undefined;
		const detailObservationIds: string[] = [];
		do {
			const response = await request(
				`/v1/traces/${traceIds[0]}?project_id=${projectId}${detailCursor ? `&cursor=${detailCursor}` : ""}`,
			);
			expect(response.status).toBe(200);
			const raw = await response.text();
			const page = JSON.parse(raw) as {
				observations: Array<{
					observation_id: string;
					input_text: string;
					output_text: string;
					input_retained_truncated?: boolean;
					output_retained_truncated?: boolean;
				}>;
				next_cursor?: string;
			};
			expect(encoder.encode(raw).byteLength).toBeLessThanOrEqual(
				MAX_TRACE_RESPONSE_BYTES,
			);
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

		for (const [traceId, overLimit] of [
			[traceIds[2]!, false],
			[traceIds[3]!, true],
		] as const) {
			const response = await request(
				`/v1/traces/${traceId}?project_id=${projectId}`,
			);
			expect(response.status).toBe(200);
			const raw = await response.text();
			const page = JSON.parse(raw) as {
				observations: Array<{ metadata: { truncated?: boolean } }>;
			};
			expect(encoder.encode(raw).byteLength).toBeLessThanOrEqual(
				MAX_TRACE_RESPONSE_BYTES,
			);
			expect(page.observations).toHaveLength(1);
			expect(page.observations[0]!.metadata.truncated === true).toBe(overLimit);
		}

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
