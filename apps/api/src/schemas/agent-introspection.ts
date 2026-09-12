import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";

const SafeToken = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/);
const Uuid = z.string().uuid();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const FailureClass = z.enum([
	"authentication",
	"authorization",
	"rate_limited",
	"timeout",
	"transport",
	"provider_rejected",
	"invalid_response",
	"tool_error",
	"adapter_error",
	"cancelled",
	"unknown",
]);
const Capabilities = [
	"agent_lifecycle",
	"model_calls",
	"tool_calls",
	"workflows",
	"teams",
	"handoffs",
	"retries",
	"streaming",
	"trace_linkage",
	"content_references",
	"cost",
] as const;
const Capability = z.enum(Capabilities);
const capabilityForEvent: Record<string, (typeof Capabilities)[number]> = {
	"agent.started": "agent_lifecycle",
	"agent.completed": "agent_lifecycle",
	"agent.failed": "agent_lifecycle",
	"agent.cancelled": "agent_lifecycle",
	"model.started": "model_calls",
	"model.completed": "model_calls",
	"model.failed": "model_calls",
	"tool.started": "tool_calls",
	"tool.completed": "tool_calls",
	"tool.failed": "tool_calls",
	"workflow.started": "workflows",
	"workflow.completed": "workflows",
	"workflow.failed": "workflows",
	"team.started": "teams",
	"team.completed": "teams",
	"team.failed": "teams",
	handoff: "handoffs",
	retry: "retries",
	"stream.summary": "streaming",
};

const CapabilityDeclaration = z
	.object({
		capability: Capability,
		support: z.enum(["supported", "unsupported", "unknown"]),
		reason: z
			.enum([
				"framework_unsupported",
				"adapter_unsupported",
				"not_instrumented",
				"version_unknown",
				"unknown",
			])
			.nullable(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if ((value.support === "supported") !== (value.reason === null))
			ctx.addIssue({ code: "custom", message: "Capability support and reason disagree" });
	});

const EvidenceReference = z
	.object({
		kind: z.enum(["input", "output", "prompt", "tool_arguments", "tool_result"]),
		source: z.enum([
			"evaluation_run_item",
			"trace",
			"observation",
			"prompt_version",
			"content_digest",
		]),
		id: z.string().min(1).max(256),
		sha256: Sha256.nullable(),
		byte_count: z.number().int().nonnegative().nullable(),
		redacted: z.boolean(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const valid =
			(value.source === "evaluation_run_item" && Uuid.safeParse(value.id).success) ||
			(value.source === "trace" && /^[a-f0-9]{32}$/.test(value.id)) ||
			(value.source === "observation" && value.id.length <= 256) ||
			(value.source === "prompt_version" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}@[1-9][0-9]*$/.test(value.id)) ||
			(value.source === "content_digest" && /^[a-f0-9]{64}$/.test(value.id));
		if (!valid) ctx.addIssue({ code: "custom", message: "Reference identifier is invalid" });
	});

const EventBase = z.object({
	event_id: Uuid,
	sequence: z.number().int().min(0).max(255),
	occurred_at: z.string().datetime(),
	operation_id: Uuid,
	parent_event_id: Uuid.nullable(),
	trace: z
		.object({
			trace_id: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
			span_id: z.string().regex(/^[a-f0-9]{16}$/).nullable(),
		})
		.strict(),
	references: z.array(EvidenceReference).max(8),
});
const AgentKey = z.object({ agent_key: SafeToken });
const Duration = z.object({ duration_ms: z.number().int().min(0).max(86_400_000) });
const Failure = z.object({ classification: FailureClass, retryable: z.boolean() });
const Model = z.object({ provider: SafeToken.nullable(), model: SafeToken, attempt: z.number().int().min(1).max(10) });
const Tool = z.object({ tool: SafeToken, attempt: z.number().int().min(1).max(10) });
const Workflow = z.object({ workflow: SafeToken });
const Team = z.object({ team: SafeToken });
const event = <T extends string, D extends z.ZodObject>(type: T, detail: D) =>
	EventBase.extend({ type: z.literal(type), detail: detail.strict() }).strict();

const Events = z.discriminatedUnion("type", [
	event("agent.started", AgentKey.extend({ version_fingerprint: Sha256.nullable() })),
	event("agent.completed", AgentKey.merge(Duration)),
	event("agent.failed", AgentKey.merge(Duration).merge(Failure)),
	event("agent.cancelled", AgentKey.merge(Duration).extend({ classification: z.literal("cancelled") })),
	event("model.started", Model),
	event("model.completed", Model.merge(Duration).extend({ input_tokens: z.number().int().nonnegative().nullable(), output_tokens: z.number().int().nonnegative().nullable(), cost_usd: z.number().nonnegative().nullable() })),
	event("model.failed", Model.merge(Duration).merge(Failure)),
	event("tool.started", Tool),
	event("tool.completed", Tool.merge(Duration)),
	event("tool.failed", Tool.merge(Duration).merge(Failure)),
	event("workflow.started", Workflow),
	event("workflow.completed", Workflow.merge(Duration)),
	event("workflow.failed", Workflow.merge(Duration).merge(Failure)),
	event("team.started", Team),
	event("team.completed", Team.merge(Duration)),
	event("team.failed", Team.merge(Duration).merge(Failure)),
	event("handoff", z.object({ from_agent_key: SafeToken, to_agent_key: SafeToken, reason_code: z.enum(["delegated", "routed", "fallback", "unknown"]) })),
	event("retry", z.object({ retried_operation_id: Uuid, next_attempt: z.number().int().min(2).max(10), classification: FailureClass })),
	event("stream.summary", z.object({ streamed_operation_id: Uuid, chunk_count: z.number().int().nonnegative(), byte_count: z.number().int().nonnegative(), duration_ms: z.number().int().min(0).max(86_400_000) })),
	event("error", z.object({ source: z.enum(["adapter", "framework", "model", "tool", "workflow", "team"]), classification: FailureClass, retryable: z.boolean(), affected_operation_id: Uuid.nullable() })),
]);

const ReportShape = z
	.object({
		contract_version: z.literal("agent-introspection.v1"),
		adapter: z.object({ name: SafeToken, version: SafeToken, framework: SafeToken, framework_version: SafeToken.nullable() }).strict(),
		capabilities: z.array(CapabilityDeclaration).length(Capabilities.length),
		capture: z.object({ source: z.literal("client_reported"), content_mode: z.literal("references_only"), sampling: z.enum(["full", "sampled", "unknown"]) }).strict(),
		outcome: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
		completeness: z.enum(["complete", "partial", "unknown"]),
		omissions: z.array(z.enum(["adapter_error", "process_terminated", "limit_exceeded", "sampled", "unsupported", "flush_timeout", "unknown"])).max(16),
		events: z.array(Events).max(256),
	})
	.strict();

export function canonicalAgentIntrospectionJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalAgentIntrospectionJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalAgentIntrospectionJson(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

export const AgentIntrospectionReportV1 = ReportShape.superRefine((report, ctx) => {
	const capabilitySupport = new Map(report.capabilities.map((item) => [item.capability, item.support]));
	if (capabilitySupport.size !== Capabilities.length)
		ctx.addIssue({ code: "custom", message: "Every v1 capability must be declared exactly once", path: ["capabilities"] });
	for (const capability of Capabilities)
		if (!capabilitySupport.has(capability)) ctx.addIssue({ code: "custom", message: "Missing capability declaration", path: ["capabilities"] });
	const omissions = new Set(report.omissions);
	if (omissions.size !== report.omissions.length) ctx.addIssue({ code: "custom", message: "Omissions must be unique", path: ["omissions"] });
	if (report.completeness === "complete" && report.omissions.length) ctx.addIssue({ code: "custom", message: "Complete reports cannot have omissions", path: ["omissions"] });
	if (report.completeness === "partial" && !report.omissions.length) ctx.addIssue({ code: "custom", message: "Partial reports require omissions", path: ["omissions"] });
	if (report.capture.sampling === "sampled" && !omissions.has("sampled")) ctx.addIssue({ code: "custom", message: "Sampled capture requires sampled omission", path: ["omissions"] });
	const eventIds = new Set<string>();
	const earlierIds = new Set<string>();
	const operations = new Set<string>();
	const attempts = new Map<string, number>();
	let rootStarts = 0;
	for (const [index, candidate] of report.events.entries()) {
		const event = candidate as any;
		if (event.sequence !== index) ctx.addIssue({ code: "custom", message: "Event sequences must be contiguous and ordered", path: ["events", index, "sequence"] });
		if (eventIds.has(event.event_id)) ctx.addIssue({ code: "custom", message: "Event IDs must be unique", path: ["events", index, "event_id"] });
		eventIds.add(event.event_id);
		if (event.parent_event_id && !earlierIds.has(event.parent_event_id)) ctx.addIssue({ code: "custom", message: "Parent event must appear earlier", path: ["events", index, "parent_event_id"] });
		const capability = event.type === "error" ? ({ adapter: "agent_lifecycle", framework: "agent_lifecycle", model: "model_calls", tool: "tool_calls", workflow: "workflows", team: "teams" } as Record<string, (typeof Capabilities)[number]>)[event.detail.source] : capabilityForEvent[event.type];
		if (capability && capabilitySupport.get(capability) !== "supported") ctx.addIssue({ code: "custom", message: "Event uses an unsupported capability", path: ["events", index] });
		if ((event.trace.trace_id || event.trace.span_id) && capabilitySupport.get("trace_linkage") !== "supported") ctx.addIssue({ code: "custom", message: "Trace linkage requires capability support", path: ["events", index, "trace"] });
		if (event.references.length && capabilitySupport.get("content_references") !== "supported") ctx.addIssue({ code: "custom", message: "References require capability support", path: ["events", index, "references"] });
		if (event.type === "retry") {
			if (!operations.has(event.detail.retried_operation_id) || event.detail.next_attempt <= (attempts.get(event.detail.retried_operation_id) ?? 0)) ctx.addIssue({ code: "custom", message: "Retry must advance a prior operation attempt", path: ["events", index, "detail"] });
		}
		if (event.type === "stream.summary" && !operations.has(event.detail.streamed_operation_id)) ctx.addIssue({ code: "custom", message: "Stream summary must reference a prior operation", path: ["events", index, "detail"] });
		if (event.type === "error" && event.detail.affected_operation_id && !operations.has(event.detail.affected_operation_id)) ctx.addIssue({ code: "custom", message: "Error must reference a prior operation", path: ["events", index, "detail"] });
		if ("attempt" in event.detail) attempts.set(event.operation_id, event.detail.attempt);
		operations.add(event.operation_id);
		if (event.type === "agent.started" && event.parent_event_id === null) rootStarts += 1;
		earlierIds.add(event.event_id);
		if (Buffer.byteLength(canonicalAgentIntrospectionJson(event), "utf8") > 4096) ctx.addIssue({ code: "custom", message: "Canonical event exceeds 4 KiB", path: ["events", index] });
	}
	const terminalTypes = { succeeded: "agent.completed", failed: "agent.failed", cancelled: "agent.cancelled" } as const;
	const terminal = report.events.at(-1);
	if (report.completeness === "complete") {
		if (report.events[0]?.type !== "agent.started" || report.events[0].parent_event_id !== null || rootStarts !== 1) ctx.addIssue({ code: "custom", message: "Complete reports require one root agent start", path: ["events"] });
		if (report.outcome === "unknown" || !terminal || terminal.type !== terminalTypes[report.outcome] || terminal.parent_event_id !== null || terminal.operation_id !== report.events[0]?.operation_id) ctx.addIssue({ code: "custom", message: "Complete report terminal does not match outcome", path: ["events"] });
	}
	if (report.outcome !== "unknown" && (!terminal || terminal.type !== terminalTypes[report.outcome])) ctx.addIssue({ code: "custom", message: "Outcome must match the terminal event", path: ["outcome"] });
	if ((!terminal || !["agent.completed", "agent.failed", "agent.cancelled"].includes(terminal.type)) && !(report.outcome === "unknown" && report.completeness !== "complete" && report.omissions.length)) ctx.addIssue({ code: "custom", message: "Missing terminal event requires unknown incomplete report with omissions", path: ["events"] });
	if (Buffer.byteLength(canonicalAgentIntrospectionJson(report), "utf8") > 262_144) ctx.addIssue({ code: "custom", message: "Normalized report exceeds 256 KiB" });
}).openapi("AgentIntrospectionReportV1");

export type AgentIntrospectionReport = z.infer<typeof AgentIntrospectionReportV1>;
export const AgentIntrospectionPath = z.object({ run_id: Uuid, task_id: Uuid, invocation_id: Uuid }).strict();
export const AgentIntrospectionProjectQuery = z
	.object({ project_id: Uuid })
	.strict();
const Stored = z.object({ id: Uuid, organization_id: Uuid, project_id: Uuid, evaluation_run_id: Uuid, evaluation_run_item_id: Uuid, task_id: Uuid, invocation_id: Uuid, reported_by_actor_id: Uuid, source: z.literal("client_reported"), contract_version: z.literal("agent-introspection.v1"), request_hash: Sha256, outcome: ReportShape.shape.outcome, completeness: ReportShape.shape.completeness, received_at: z.string().datetime(), report: AgentIntrospectionReportV1 }).strict();
export const StoredAgentIntrospectionReportV1 = Stored.extend({ replayed: z.boolean() }).strict().openapi("StoredAgentIntrospectionReportV1");
export const ReadAgentIntrospectionReportV1 = Stored.openapi("ReadAgentIntrospectionReportV1");
export const AgentIntrospectionErrorResponses = {
	400: { description: "Invalid report", content: { "application/json": { schema: ErrorEnvelope } } },
	404: { description: "Report or scoped task not found", content: { "application/json": { schema: ErrorEnvelope } } },
	409: { description: "Immutable report identity conflict", content: { "application/json": { schema: ErrorEnvelope } } },
	413: { description: "Normalized report too large", content: { "application/json": { schema: ErrorEnvelope } } },
	500: { description: "Internal server error", content: { "application/json": { schema: ErrorEnvelope } } },
};
export function canonicalAgentIntrospectionRequestHash(report: AgentIntrospectionReport, identity: { organization_id: string; project_id: string; actor_id: string; run_id: string; task_id: string; invocation_id: string }): string {
	return createHash("sha256").update(canonicalAgentIntrospectionJson({ contract_version: report.contract_version, report, ...identity })).digest("hex");
}
