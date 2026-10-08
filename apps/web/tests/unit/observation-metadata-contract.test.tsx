import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";

const stream = vi.hoisted(() => ({
	callbacks: null as null | {
		onSnapshot: (message: {
			observations: Array<Record<string, unknown>>;
		}) => void;
		onObservation: (message: { observation: Record<string, unknown> }) => void;
		onStatus: (status: "complete" | "not_found") => void;
	},
}));

vi.mock("../../src/hooks/useTraceStream", () => ({
	useTraceStream: (
		_traceId: string,
		callbacks: NonNullable<typeof stream.callbacks>,
	) => {
		stream.callbacks = callbacks;
		return {
			status: "open" as const,
			paused: false,
			lastEventAt: Date.now(),
			reconnect: () => {},
			pause: () => {},
			resume: () => {},
			debug: {
				framesReceived: 0,
				bufferDepth: 0,
				reconnectAttempts: 0,
				lastError: null,
			},
		};
	},
}));

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
		"@tanstack/react-router",
	);
	return {
		...actual,
		useParams: () => ({ id: "0123456789abcdef0123456789abcdef" }),
		useLocation: () => ({ searchStr: "" }),
	};
});

vi.mock("../../src/components/PromptProvenanceCard", () => ({
	PromptProvenanceCard: ({ provenance }: { provenance: unknown }) => (
		<output data-testid="provenance-propagation">
			{JSON.stringify(provenance)}
		</output>
	),
}));

import {
	emptyObservationMetadata,
	listObservations,
	normalizeObservationMetadata,
} from "../../src/lib/api";
import { clearAuthSession } from "../../src/lib/auth";
import { TraceDetailPage } from "../../src/routes/observability/traces/$id";

const HASH = "a".repeat(64);
const PROVENANCE = { id: "support-agent", version: 7, content_hash: HASH };
const METADATA = {
	schema_version: 1 as const,
	attributes: [
		{ key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
	],
	prompt_provenance: PROVENANCE,
};

describe("observation metadata API-to-dashboard contract", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		stream.callbacks = null;
		window.localStorage.clear();
		clearAuthSession();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("propagates the typed API envelope through SSE detail and renders metadata as a structured tree", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					items: [
						{
							observation_id: "a".repeat(32),
							trace_id: "0123456789abcdef0123456789abcdef",
							project_id: "11111111-1111-4111-8111-111111111111",
							parent_observation_id: null,
							type: "generation",
							name: "llm.generate",
							start_time: "2026-07-15T10:00:00.000Z",
							end_time: "2026-07-15T10:00:01.000Z",
							duration_ms: 1000,
							status: "ok",
							model: "gpt-4o",
							input_text: "",
							output_text: "",
							metadata: METADATA,
						},
					],
					total: 1,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const response = await listObservations({
			project_id: "11111111-1111-4111-111111111111",
		});
		expect(response.items[0]?.metadata).toEqual(METADATA);

		render(<TraceDetailPage />);
		await waitFor(() => expect(stream.callbacks).not.toBeNull());
		await act(async () => {
			stream.callbacks!.onSnapshot({
				observations: response.items as unknown as Array<
					Record<string, unknown>
				>,
			});
		});

		await screen.findByTestId("observation-detail");
		fireEvent.click(screen.getByRole("tab", { name: "Metadata" }));
		const metadataTree = screen.getByTestId("detail-metadata");
		expect(
			within(metadataTree).getByText("schema_version"),
		).toBeInTheDocument();
		fireEvent.click(
			within(metadataTree).getByRole("button", {
				name: /Expand \$\.prompt_provenance/,
			}),
		);
		expect(metadataTree).toHaveTextContent("support-agent");
		expect(screen.getByTestId("provenance-propagation")).toHaveTextContent(
			JSON.stringify(PROVENANCE),
		);
	});

	it("normalizes supported legacy strings and fails closed for malformed metadata", () => {
		expect(
			normalizeObservationMetadata(
				JSON.stringify([
					{ key: "legacy.key", value: { stringValue: "legacy" } },
				]),
			),
		).toEqual({
			schema_version: 1,
			attributes: [{ key: "legacy.key", value: { stringValue: "legacy" } }],
			prompt_provenance: null,
		});
		expect(normalizeObservationMetadata("{not-json", true)).toEqual(
			emptyObservationMetadata(),
		);
		expect(normalizeObservationMetadata(METADATA, false)).toEqual({
			...METADATA,
			prompt_provenance: null,
		});
	});
});
