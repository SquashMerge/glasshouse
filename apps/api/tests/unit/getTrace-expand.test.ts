import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Context } from "hono";
import type { ObservationRow, TraceRow } from "../../src/db/traces-query";
import { MAX_TRACE_RESPONSE_BYTES } from "../../src/db/trace-payload-bounds";

const VALID_TRACE_ID = "0123456789abcdef0123456789abcdef";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);
const LEGACY_METADATA = JSON.stringify([
	{ key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
]);
const ENVELOPE_METADATA = JSON.stringify({
	schema_version: 1,
	attributes: [{ key: "custom.key", value: { stringValue: "value" } }],
	prompt_provenance: { id: "support-agent", version: 7, content_hash: HASH },
});
const INVALID_METADATA = JSON.stringify({ schema_version: 2, attributes: [] });

const fakeTrace: TraceRow = {
	trace_id: VALID_TRACE_ID,
	organization_id: "00000000-0000-4000-8000-000000000001",
	project_id: "proj-1",
	name: "test",
	start_time: "2024-01-01 00:00:00.000",
	end_time: null,
	duration_ms: null,
	status: "ok",
	user_id: "",
	session_id: "",
	agent_id: "",
	agent_version: "",
	env: "production",
	tags: [],
	input_text: "",
	output_text: "",
	scores_summary: "",
};

const fakeObservations: ObservationRow[] = [
	{
		observation_id: "obs-legacy",
		trace_id: VALID_TRACE_ID,
		organization_id: "00000000-0000-4000-8000-000000000001",
		project_id: "proj-1",
		parent_observation_id: null,
		type: "generation",
		name: "legacy",
		start_time: "2024-01-01 00:00:00.000",
		end_time: null,
		duration_ms: null,
		status: "ok",
		model: "gpt-4o",
		input_text: "",
		output_text: "",
		metadata: LEGACY_METADATA,
	},
	{
		observation_id: "obs-envelope",
		trace_id: VALID_TRACE_ID,
		organization_id: "00000000-0000-4000-8000-000000000001",
		project_id: "proj-1",
		parent_observation_id: null,
		type: "generation",
		name: "envelope",
		start_time: "2024-01-01 00:00:00.500",
		end_time: null,
		duration_ms: null,
		status: "ok",
		model: "gpt-4o",
		input_text: "",
		output_text: "",
		metadata: ENVELOPE_METADATA,
	},
	{
		observation_id: "obs-invalid",
		trace_id: VALID_TRACE_ID,
		organization_id: "00000000-0000-4000-8000-000000000001",
		project_id: "proj-1",
		parent_observation_id: null,
		type: "span",
		name: "invalid",
		start_time: "2024-01-01 00:00:01.000",
		end_time: null,
		duration_ms: null,
		status: "ok",
		model: null,
		input_text: "",
		output_text: "",
		metadata: INVALID_METADATA,
	},
	{
		observation_id: "obs-non-generation",
		trace_id: VALID_TRACE_ID,
		organization_id: "00000000-0000-4000-8000-000000000001",
		project_id: "proj-1",
		parent_observation_id: null,
		type: "tool",
		name: "tool",
		start_time: "2024-01-01 00:00:01.500",
		end_time: null,
		duration_ms: null,
		status: "ok",
		model: null,
		input_text: "",
		output_text: "",
		metadata: ENVELOPE_METADATA,
	},
];

const getTraceMock = mock(async () => ({
	trace: fakeTrace,
	observations: fakeObservations,
}));
const defaultClientMock = mock(() => ({}));

mock.module("../../src/db/traces-query", () => ({
	defaultClient: defaultClientMock,
	getTrace: getTraceMock,
	listTraces: mock(async () => ({ items: [], total: 0 })),
	listObservations: mock(async () => ({ items: [], total: 0 })),
}));

const { handleGetTrace } = await import("../../src/routes/traces");

beforeEach(() => {
	getTraceMock.mockClear();
	defaultClientMock.mockClear();
});

function fakeContext(traceId = VALID_TRACE_ID, projectId?: string): Context {
	const req = new Request(`http://x/v1/traces/${traceId}`, { method: "GET" });
	return {
		req: {
			valid: (target: string) =>
				target === "query" ? { project_id: projectId } : { id: traceId },
			param: (name: string) => (name === "id" ? traceId : undefined),
			query: () => undefined,
			raw: req,
		},
		json: (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), {
				status,
				headers: { "content-type": "application/json" },
			}),
		get: () => ({
			actor: "test",
			organizationId: "00000000-0000-4000-8000-000000000001",
		}),
	} as unknown as Context;
}

describe("handleGetTrace metadata envelopes", () => {
	it("bounds REST detail serialization before returning an oversized observation page", async () => {
		getTraceMock.mockResolvedValueOnce({
			trace: fakeTrace,
			observations: Array.from({ length: 100 }, (_, index) => ({
				...fakeObservations[0]!,
				observation_id: `large-${index}`,
				input_text: "界".repeat(8_000),
				output_text: "界".repeat(8_000),
				metadata: JSON.stringify({
					schema_version: 1,
					attributes: [
						{ key: "safe", value: { stringValue: "界".repeat(8_000) } },
					],
				}),
			})),
		});
		const response = await handleGetTrace(fakeContext());
		const raw = await response.text();
		expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(
			MAX_TRACE_RESPONSE_BYTES,
		);
		expect(JSON.parse(raw).response_truncated).toBe(true);
	});

	it("normalizes ClickHouse timestamps to the documented RFC3339 contract", async () => {
		const res = await handleGetTrace(fakeContext());
		const body = (await res.json()) as {
			trace: { start_time: string };
			observations: Array<{ start_time: string }>;
		};
		expect(body.trace.start_time).toBe("2024-01-01T00:00:00.000Z");
		expect(body.observations[0]?.start_time).toBe("2024-01-01T00:00:00.000Z");
	});

	it("reads legacy arrays as typed attributes with null prompt provenance", async () => {
		const res = await handleGetTrace(fakeContext());
		const body = (await res.json()) as {
			observations: Array<{ observation_id: string; metadata: unknown }>;
		};
		expect(
			body.observations.find(
				(observation) => observation.observation_id === "obs-legacy",
			)?.metadata,
		).toEqual({
			schema_version: 1,
			attributes: [
				{ key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
			],
			prompt_provenance: null,
		});
	});

	it("exposes a persisted envelope and its exact typed provenance", async () => {
		const res = await handleGetTrace(fakeContext());
		const body = (await res.json()) as {
			observations: Array<{ observation_id: string; metadata: unknown }>;
		};
		expect(
			body.observations.find(
				(observation) => observation.observation_id === "obs-envelope",
			)?.metadata,
		).toEqual({
			schema_version: 1,
			attributes: [{ key: "custom.key", value: { stringValue: "value" } }],
			prompt_provenance: {
				id: "support-agent",
				version: 7,
				content_hash: HASH,
			},
		});
	});

	it("fails closed for invalid persisted envelopes", async () => {
		const res = await handleGetTrace(fakeContext());
		const body = (await res.json()) as {
			observations: Array<{ observation_id: string; metadata: unknown }>;
		};
		expect(
			body.observations.find(
				(observation) => observation.observation_id === "obs-invalid",
			)?.metadata,
		).toEqual({
			schema_version: 1,
			attributes: [],
			prompt_provenance: null,
		});
	});

	it("does not expose persisted provenance on a non-generation observation", async () => {
		const res = await handleGetTrace(fakeContext());
		const body = (await res.json()) as {
			observations: Array<{ observation_id: string; metadata: unknown }>;
		};
		expect(
			body.observations.find(
				(observation) => observation.observation_id === "obs-non-generation",
			)?.metadata,
		).toEqual({
			schema_version: 1,
			attributes: [{ key: "custom.key", value: { stringValue: "value" } }],
			prompt_provenance: null,
		});
	});

	it("returns 404 when the trace is absent", async () => {
		getTraceMock.mockResolvedValueOnce({ trace: null, observations: [] });
		const res = await handleGetTrace(fakeContext());
		expect(res.status).toBe(404);
		expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND");
	});

	it("scopes a trace lookup to the requested project", async () => {
		const res = await handleGetTrace(fakeContext(VALID_TRACE_ID, PROJECT_ID));
		expect(res.status).toBe(200);
		expect(getTraceMock).toHaveBeenCalledWith(
			expect.anything(),
			"00000000-0000-4000-8000-000000000001",
			VALID_TRACE_ID,
			PROJECT_ID,
		);
	});

	it("returns the same 404 for a trace owned by another project", async () => {
		getTraceMock.mockResolvedValueOnce({ trace: null, observations: [] });
		const res = await handleGetTrace(fakeContext(VALID_TRACE_ID, PROJECT_ID));
		expect(res.status).toBe(404);
		expect(getTraceMock).toHaveBeenCalledWith(
			expect.anything(),
			"00000000-0000-4000-8000-000000000001",
			VALID_TRACE_ID,
			PROJECT_ID,
		);
	});
});
