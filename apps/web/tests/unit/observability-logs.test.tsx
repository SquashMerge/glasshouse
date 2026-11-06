import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LogsTab, logTimestamp } from "../../src/routes/observability-logs";
import type { LogRecord } from "../../src/lib/api";

const state = vi.hoisted(() => ({
	project: "11111111-1111-4111-8111-111111111111",
	list: vi.fn(),
}));
vi.mock("../../src/components/ProjectProvider", () => ({
	useProjectSelection: () => ({ selectedProjectId: state.project }),
}));
vi.mock("@tanstack/react-router", () => ({
	useLocation: () => ({ searchStr: "?tab=logs" }),
}));
vi.mock("../../src/lib/api", () => ({ listLogs: state.list }));

const row: LogRecord = {
	log_id: "a".repeat(64),
	project_id: state.project,
	time_unix_nano: "1700000000123456789",
	observed_time_unix_nano: "1700000000987654321",
	ingested_time_unix_nano: "1700000001000000000",
	effective_time_unix_nano: "1700000000123456789",
	severity_number: 13,
	severity_text: "WARN",
	trace_id: "b".repeat(32),
	span_id: "c".repeat(16),
	flags: 1,
	dropped_attributes_count: 2,
	event_name: "",
	body: {
		kvlistValue: {
			values: [{ key: "counter", value: { intValue: "9223372036854775807" } }],
		},
	},
	attributes: [],
	resource: { attributes: [], droppedAttributesCount: 0 },
	scope: {
		name: "sdk.logs",
		version: "1",
		attributes: [],
		droppedAttributesCount: 0,
	},
	resource_schema_url: "",
	scope_schema_url: "",
};
function view(client: QueryClient) {
	return (
		<QueryClientProvider client={client}>
			<LogsTab />
		</QueryClientProvider>
	);
}
beforeEach(() => {
	state.project = row.project_id;
	state.list.mockReset();
	window.history.replaceState({}, "", "/observability?tab=logs");
});
afterEach(cleanup);

it("shows exact nanoseconds and typed details, then drops private detail on a Project change", async () => {
	state.list.mockImplementation(async ({ project_id }) => ({
		items: project_id === row.project_id ? [row] : [],
		total: project_id === row.project_id ? 1 : 0,
	}));
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	const rendered = render(view(client));
	const timestamp = await screen.findByText("2023-11-14T22:13:20.123456789Z");
	expect(logTimestamp(row.time_unix_nano)).toBe(timestamp.textContent);
	fireEvent.click(timestamp);
	expect(screen.getByRole("dialog")).toHaveTextContent("9223372036854775807");
	expect(screen.getByRole("dialog")).toHaveTextContent(
		row.observed_time_unix_nano,
	);
	expect(
		screen.getByRole("link", { name: "Inspect correlated trace" }),
	).toHaveAttribute(
		"href",
		`/observability/traces/${row.trace_id}?span=${row.span_id}`,
	);
	state.project = "22222222-2222-4222-8222-222222222222";
	rendered.rerender(view(client));
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(await screen.findByText(/No logs yet/)).toBeInTheDocument();
});

it("offers recovery for query failures and retains filter state in the URL", async () => {
	state.list
		.mockRejectedValueOnce(new Error("Log query failed"))
		.mockResolvedValue({ items: [], total: 0 });
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(view(client));
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"Log query failed",
	);
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await screen.findByText(/No logs yet/);
	fireEvent.change(screen.getByLabelText("Body"), {
		target: { value: "safe marker" },
	});
	await waitFor(() =>
		expect(state.list).toHaveBeenLastCalledWith(
			expect.objectContaining({ project_id: state.project, q: "safe marker" }),
		),
	);
	expect(new URLSearchParams(window.location.search).get("logs.q")).toBe(
		"safe marker",
	);
});

it("labels the body search by its product name while preserving the q API and URL key", async () => {
	state.list.mockResolvedValue({ items: [], total: 0 });
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(view(client));
	await screen.findByText(/No logs yet/);
	const body = screen.getByRole("textbox", { name: "Body" });
	expect(body.closest("label")).toHaveTextContent("Body");
	expect(
		screen.queryByRole("textbox", { name: /^Q$/ }),
	).not.toBeInTheDocument();
	fireEvent.change(body, { target: { value: "retained marker" } });
	await waitFor(() =>
		expect(state.list).toHaveBeenLastCalledWith(
			expect.objectContaining({ q: "retained marker" }),
		),
	);
	expect(new URLSearchParams(window.location.search).get("logs.q")).toBe(
		"retained marker",
	);
});

it("marks a clipped body preview without splitting Unicode and keeps the full retained detail", async () => {
	const body = `${"x".repeat(199)}😀retained tail`;
	state.list.mockResolvedValue({
		items: [{ ...row, body: { stringValue: body } }],
		total: 1,
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(view(client));
	fireEvent.click(await screen.findByText(`${"x".repeat(199)}😀…`));
	expect(screen.getByLabelText("Full retained log record")).toHaveTextContent(
		body,
	);
});

it("discards an open detail after a refresh fails and does not reopen it on recovery", async () => {
	state.list.mockResolvedValue({ items: [row], total: 1 });
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(view(client));
	fireEvent.click(await screen.findByText("2023-11-14T22:13:20.123456789Z"));
	expect(screen.getByRole("dialog")).toBeInTheDocument();
	state.list.mockRejectedValueOnce(new Error("Log query failed"));
	await act(async () => {
		await client.refetchQueries({ queryKey: ["logs"] });
	});
	await screen.findByRole("alert");
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() =>
		expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
	);
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("inspects the clicked physical payload when log IDs repeat across pages", async () => {
	const first = { ...row, body: { stringValue: "first physical payload" } };
	const second = { ...row, body: { stringValue: "second physical payload" } };
	state.list.mockImplementation(async ({ cursor }) =>
		cursor
			? { items: [second], total: 2 }
			: { items: [first], total: 2, next_cursor: "physical-row-cursor" },
	);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	const errors = vi.spyOn(console, "error");
	let enterViewport = () => {};
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
				enterViewport = () => callback([{ isIntersecting: true }]);
			}
			observe() {}
			disconnect() {}
		},
	);
	try {
		render(view(client));
		await screen.findByText("first physical payload");
		await act(async () => enterViewport());
		fireEvent.click(await screen.findByText("second physical payload"));
		expect(screen.getByLabelText("Full retained log record")).toHaveTextContent(
			"second physical payload",
		);
		expect(
			screen.getByLabelText("Full retained log record"),
		).not.toHaveTextContent("first physical payload");
		expect(errors.mock.calls.flat().join(" ")).not.toMatch(
			/same key|unique.*key/i,
		);
	} finally {
		errors.mockRestore();
		vi.unstubAllGlobals();
	}
});
