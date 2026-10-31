import { authedFetch } from "./auth";

export type JsonObject = Record<string, unknown>;

export interface ApiErrorEnvelope {
	code: string;
	message: string;
	details?: ApiErrorDetails;
}

export interface ApiValidationIssue {
	item_id: string | null;
	item_key: string | null;
	field: string;
	code: string;
	message: string;
}

export interface ApiErrorDetails {
	errors?: ApiValidationIssue[];
	current_revision?: number;
	field_diff?: Array<{
		field: string;
		current: unknown;
		requested: unknown;
	}>;
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: ApiErrorDetails,
	) {
		super(message);
		this.name = "ApiError";
	}
}

async function responseJson<T>(
	response: Response,
	operation: string,
): Promise<T> {
	if (response.ok)
		return response.status === 204
			? (undefined as T)
			: (response.json() as Promise<T>);

	let envelope: ApiErrorEnvelope | null = null;
	try {
		envelope = (await response.json()) as ApiErrorEnvelope;
	} catch {
		envelope = null;
	}
	throw new ApiError(
		response.status,
		envelope?.code ?? "REQUEST_FAILED",
		envelope?.message ?? `${operation} ${response.status}`,
		envelope?.details,
	);
}

function jsonRequest(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

export interface LocalAccount {
	actor_id: string;
	username: string;
	organization_role: "admin" | "user" | "read_only" | null;
	status: "active" | "pending" | "disabled";
	enrollments: Array<{
		id: string;
		status: "pending" | "expired" | "revoked" | "consumed";
		created_at: string;
		expires_at: string;
	}>;
}
export interface EnrollmentCode {
	actor_id: string;
	username: string;
	enrollment_id: string;
	code: string;
}
export async function listLocalAccounts(): Promise<{ items: LocalAccount[] }> {
	return responseJson(
		await authedFetch("/v1/admin/local-accounts"),
		"List accounts",
	);
}
export async function provisionLocalAccount(
	username: string,
	role: NonNullable<LocalAccount["organization_role"]>,
): Promise<EnrollmentCode> {
	return responseJson(
		await authedFetch(
			"/v1/admin/local-accounts",
			jsonRequest({ username, role }),
		),
		"Provision account",
	);
}
export async function resetLocalAccount(
	actorId: string,
): Promise<EnrollmentCode> {
	return responseJson(
		await authedFetch(
			`/v1/admin/local-accounts/${encodeURIComponent(actorId)}/reset`,
			{ method: "POST" },
		),
		"Reset account",
	);
}
export async function setLocalAccountEnabled(
	actorId: string,
	enabled: boolean,
): Promise<void> {
	await responseJson(
		await authedFetch(
			`/v1/admin/local-accounts/${encodeURIComponent(actorId)}/status`,
			{ ...jsonRequest({ enabled }), method: "PUT" },
		),
		"Set account status",
	);
}
export async function revokeLocalEnrollment(
	enrollmentId: string,
): Promise<void> {
	await responseJson(
		await authedFetch(
			`/v1/admin/local-enrollments/${encodeURIComponent(enrollmentId)}`,
			{ method: "DELETE" },
		),
		"Revoke enrollment",
	);
}

export async function changeOwnPassword(
	currentPassword: string,
	newPassword: string,
): Promise<void> {
	await responseJson(
		await authedFetch(
			"/v1/auth/password",
			jsonRequest({
				current_password: currentPassword,
				new_password: newPassword,
			}),
		),
		"Change password",
	);
}

export interface Dataset {
	id: string;
	project_id: string;
	slug: string;
	name: string;
	description: string | null;
	tags: string[];
	revision: number;
	latest_published_version: number | null;
	archived_at: string | null;
	item_count: number;
	created_at: string;
	updated_at: string;
}
export interface DatasetDraft {
	id: string;
	project_id: string;
	dataset_id: string;
	base_version: number | null;
	revision: number;
	item_count: number;
	created_at: string;
	updated_at: string;
}
export interface DatasetVersionSummary {
	id: string;
	dataset_id: string;
	project_id: string;
	version: number;
	item_count: number;
	content_hash: string;
	validation_version: number;
	published_by: string | null;
	published_draft_revision: number | null;
	created_at: string;
}
export interface DatasetVersion extends DatasetVersionSummary {
	items: Array<{
		id: string;
		item_key: string;
		position: number;
		validation_version: number;
		state: "draft" | "reviewed";
		input: JsonObject;
		expected_output: JsonObject | null;
		metadata: JsonObject;
		external_id: string | null;
		source_trace_id: string | null;
		source_observation_id: string | null;
		feedback_score_id: string | null;
		capture_context: {
			kind?: "trace" | "observation" | "feedback";
			redaction_applied?: boolean;
		};
		curated_by: string | null;
		curated_by_username: string | null;
		reviewed_by: string | null;
		reviewed_by_username: string | null;
		reviewed_at: string | null;
		created_at: string;
	}>;
}
export interface EvaluationDefinition {
	dataset_version_id: string;
	sampling: { strategy: "first_n"; sample_size: number; seed: number };
	evaluator: {
		kind: "exact_match" | "contains";
		version: "v1";
		expected_output_path: string;
		output_path: string;
	};
	target: {
		kind: "configured_llm";
		provider?: "openai" | "codex_cli";
		model: string | null;
		system_prompt: string | null;
	};
	execution_defaults: { temperature: number; max_tokens: number | null };
	limits: { max_cost_usd: number; max_duration_seconds: number };
	thresholds: { minimum_pass_rate: number | null };
}
export interface Evaluation {
	id: string;
	project_id: string;
	slug: string;
	name: string;
	description: string | null;
	lifecycle_revision: number;
	archived_at: string | null;
	tombstoned_at: string | null;
	created_at: string;
	updated_at: string;
}
export interface EvaluationDraft extends EvaluationDefinition {
	evaluation_id: string;
	project_id: string;
	revision: number;
	updated_at: string;
	definition_contract: "v1";
}
export interface LegacyIncompleteEvaluationDraft {
	evaluation_id: string;
	project_id: string;
	revision: number;
	updated_at: string;
	definition_contract: "legacy_incomplete";
	dataset_version_id: string;
	sampling: Record<string, unknown>;
	evaluator: Record<string, unknown>;
	target: Record<string, unknown>;
	execution_defaults: Record<string, unknown>;
	limits: Record<string, unknown>;
	thresholds: Record<string, unknown>;
}
export type EvaluationDraftResponse =
	| EvaluationDraft
	| LegacyIncompleteEvaluationDraft;
export interface EvaluationDefinitionVersion {
	id: string;
	evaluation_id: string;
	project_id: string;
	version: number;
	content_hash: string;
	published_by: string;
	published_draft_revision: number;
	created_at: string;
	definition_contract: "v1" | "legacy_untyped" | "legacy_incompatible";
	dataset_version_id: string;
	sampling: EvaluationDefinition["sampling"] | null;
	evaluator: Record<string, unknown>;
	target: Record<string, unknown>;
	execution_defaults: Record<string, unknown>;
	limits: EvaluationDefinition["limits"] | null;
	thresholds: Record<string, unknown>;
}
export async function listEvaluations(
	project_id: string,
	include_archived = false,
): Promise<{ items: Evaluation[]; total: number }> {
	return responseJson(
		await authedFetch(
			`/v1/evaluations${buildQs({ project_id, include_archived: include_archived ? "true" : undefined })}`,
		),
		"listEvaluations",
	);
}
export async function archiveEvaluation(input: {
	project_id: string;
	slug: string;
	revision: number;
}): Promise<void> {
	const response = await authedFetch(
		`/v1/evaluations/${encodeURIComponent(input.slug)}${buildQs({ project_id: input.project_id })}`,
		{ method: "DELETE", headers: { "if-match": `\"${input.revision}\"` } },
	);
	if (!response.ok) await responseJson<never>(response, "archiveEvaluation");
}
export async function restoreEvaluation(input: {
	project_id: string;
	slug: string;
	revision: number;
}): Promise<void> {
	const response = await authedFetch(
		`/v1/evaluations/${encodeURIComponent(input.slug)}/restore${buildQs({ project_id: input.project_id })}`,
		{ method: "POST", headers: { "if-match": `\"${input.revision}\"` } },
	);
	if (!response.ok) await responseJson<never>(response, "restoreEvaluation");
}
export async function tombstoneEvaluation(input: {
	project_id: string;
	slug: string;
	revision: number;
	confirmation_slug: string;
}): Promise<void> {
	const response = await authedFetch(
		`/v1/evaluations/${encodeURIComponent(input.slug)}/tombstone${buildQs({ project_id: input.project_id })}`,
		{
			method: "DELETE",
			headers: {
				"content-type": "application/json",
				"if-match": `\"${input.revision}\"`,
			},
			body: JSON.stringify({ confirmation_slug: input.confirmation_slug }),
		},
	);
	if (!response.ok) await responseJson<never>(response, "tombstoneEvaluation");
}
export async function getEvaluation(input: {
	project_id: string;
	slug: string;
}): Promise<Evaluation> {
	return responseJson(
		await authedFetch(
			`/v1/evaluations/${encodeURIComponent(input.slug)}${buildQs({ project_id: input.project_id })}`,
		),
		"getEvaluation",
	);
}
export async function createEvaluation(input: {
	project_id: string;
	slug: string;
	name: string;
	description?: string | null;
	definition: EvaluationDefinition;
}): Promise<{ evaluation: Evaluation; draft: EvaluationDraft }> {
	return responseJson(
		await authedFetch(
			`/v1/evaluations${buildQs({ project_id: input.project_id })}`,
			jsonRequest({ ...input, project_id: undefined }),
		),
		"createEvaluation",
	);
}
export async function getEvaluationDraft(input: {
	project_id: string;
	slug: string;
}): Promise<EvaluationDraftResponse> {
	return responseJson(
		await authedFetch(
			`/v1/evaluations/${encodeURIComponent(input.slug)}/draft${buildQs({ project_id: input.project_id })}`,
		),
		"getEvaluationDraft",
	);
}
export async function updateEvaluationDraft(input: {
	project_id: string;
	slug: string;
	revision: number;
	definition: EvaluationDefinition;
}): Promise<EvaluationDraft> {
	return responseJson(
		await authedFetch(
			`/v1/evaluations/${encodeURIComponent(input.slug)}/draft${buildQs({ project_id: input.project_id })}`,
			{
				method: "PUT",
				headers: {
					"content-type": "application/json",
					"if-match": `"${input.revision}"`,
				},
				body: JSON.stringify(input.definition),
			},
		),
		"updateEvaluationDraft",
	);
}
export async function publishEvaluationDraft(input: {
	project_id: string;
	slug: string;
	revision: number;
}): Promise<EvaluationDefinitionVersion> {
	return responseJson(
		await authedFetch(
			`/v1/evaluations/${encodeURIComponent(input.slug)}/draft/publish${buildQs({ project_id: input.project_id })}`,
			{ method: "POST", headers: { "if-match": `\"${input.revision}\"` } },
		),
		"publishEvaluationDraft",
	);
}
export async function listEvaluationVersions(input: {
	project_id: string;
	slug: string;
}): Promise<{ items: EvaluationDefinitionVersion[] }> {
	return responseJson(
		await authedFetch(
			`/v1/evaluations/${encodeURIComponent(input.slug)}/versions${buildQs({ project_id: input.project_id })}`,
		),
		"listEvaluationVersions",
	);
}
export async function getEvaluationVersion(input: {
	project_id: string;
	slug: string;
	version: number;
}): Promise<EvaluationDefinitionVersion> {
	return responseJson(
		await authedFetch(
			`/v1/evaluations/${encodeURIComponent(input.slug)}/versions/${input.version}${buildQs({ project_id: input.project_id })}`,
		),
		"getEvaluationVersion",
	);
}
export type EvaluationGateContext = "ci" | "release";
export type EvaluationGateApprovalStatus = "active" | "revoked" | "superseded";
export interface EvaluationGateApproval {
	id: string;
	organization_id: string;
	project_id: string;
	evaluation_id: string;
	definition_version_id: string;
	definition_version: number;
	definition_contract: "v1" | "legacy_incompatible";
	dataset_version_id: string;
	definition_content_hash: string;
	dataset_content_hash: string;
	gate_context: EvaluationGateContext;
	minimum_pass_rate: number;
	reason: string;
	approved_by_actor_id: string;
	approved_at: string;
	revoked_at: string | null;
	revoked_by_actor_id: string | null;
	revocation_reason: string | null;
	superseded_by: string | null;
	status: EvaluationGateApprovalStatus;
	created_at: string;
}
export interface EvaluationGateRun {
	id: string;
	organization_id: string;
	project_id: string;
	approval_id: string;
	evaluation_run_id: string;
	evaluation_id: string;
	definition_version_id: string;
	dataset_version_id: string;
	definition_content_hash: string;
	dataset_content_hash: string;
	target_fingerprint: string;
	evaluator_fingerprint: string;
	gate_context: EvaluationGateContext;
	minimum_pass_rate: number;
	selected_count: number | null;
	evaluated_count: number | null;
	passed_count: number | null;
	failed_count: number | null;
	status:
		| "pending"
		| "passed"
		| "failed"
		| "inconclusive"
		| "error"
		| "cancelled";
	outcome_reason: string | null;
	requested_by_actor_id: string;
	idempotency_key: string;
	created_at: string;
	updated_at: string;
}
export async function createEvaluationGateApproval(input: {
	project_id: string;
	definition_version_id: string;
	gate_context: EvaluationGateContext;
	reason: string;
	supersedes_approval_id?: string | null;
}): Promise<EvaluationGateApproval> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-gates/approvals${buildQs({ project_id: input.project_id })}`,
			jsonRequest({
				definition_version_id: input.definition_version_id,
				gate_context: input.gate_context,
				reason: input.reason,
				supersedes_approval_id: input.supersedes_approval_id,
			}),
		),
		"createEvaluationGateApproval",
	);
}
export async function listEvaluationGateApprovals(input: {
	project_id: string;
	include_revoked?: boolean;
}): Promise<{ items: EvaluationGateApproval[]; total: number }> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-gates/approvals${buildQs({
				project_id: input.project_id,
				include_revoked: input.include_revoked ? "true" : undefined,
			})}`,
		),
		"listEvaluationGateApprovals",
	);
}
export async function getEvaluationGateApproval(input: {
	project_id: string;
	id: string;
}): Promise<EvaluationGateApproval> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-gates/approvals/${encodeURIComponent(input.id)}${buildQs({ project_id: input.project_id })}`,
		),
		"getEvaluationGateApproval",
	);
}
export interface EvaluationGateAuditEvent {
	id: string;
	approval_id: string;
	gate_run_id: string | null;
	evaluation_run_id: string | null;
	definition_version_id: string;
	actor_id: string;
	event_type:
		| "approved"
		| "revoked"
		| "superseded"
		| "invoked"
		| "outcome_recorded";
	gate_context: EvaluationGateContext | null;
	outcome_status: EvaluationGateRun["status"] | null;
	reason_digest: string | null;
	created_at: string;
}
export async function getEvaluationGateApprovalHistory(input: {
	project_id: string;
	id: string;
}): Promise<{ items: EvaluationGateAuditEvent[] }> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-gates/approvals/${encodeURIComponent(input.id)}/history${buildQs({ project_id: input.project_id })}`,
		),
		"getEvaluationGateApprovalHistory",
	);
}
export async function revokeEvaluationGateApproval(input: {
	project_id: string;
	id: string;
	reason: string;
}): Promise<EvaluationGateApproval> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-gates/approvals/${encodeURIComponent(input.id)}/revoke${buildQs({ project_id: input.project_id })}`,
			jsonRequest({ reason: input.reason }),
		),
		"revokeEvaluationGateApproval",
	);
}
export async function startEvaluationGate(input: {
	project_id: string;
	approval_id: string;
	definition_version_id: string;
	dataset_version_id: string;
	gate_context: EvaluationGateContext;
	idempotency_key: string;
	trigger_metadata?: Record<string, string | number | boolean | null>;
}): Promise<EvaluationGateRun> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-gates/runs${buildQs({ project_id: input.project_id })}`,
			{
				...jsonRequest({
					approval_id: input.approval_id,
					definition_version_id: input.definition_version_id,
					dataset_version_id: input.dataset_version_id,
					gate_context: input.gate_context,
					trigger_metadata: input.trigger_metadata ?? { source: "dashboard" },
				}),
				headers: {
					"content-type": "application/json",
					"idempotency-key": input.idempotency_key,
				},
			},
		),
		"startEvaluationGate",
	);
}
export async function listEvaluationGateRuns(input: {
	project_id: string;
	status?: EvaluationGateRun["status"];
	limit?: number;
	offset?: number;
}): Promise<{ items: EvaluationGateRun[]; total: number }> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-gates/runs${buildQs({
				project_id: input.project_id,
				status: input.status,
				limit: input.limit,
				offset: input.offset,
			})}`,
		),
		"listEvaluationGateRuns",
	);
}
export async function getEvaluationGateRun(input: {
	project_id: string;
	id: string;
}): Promise<EvaluationGateRun> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-gates/runs/${encodeURIComponent(input.id)}${buildQs({ project_id: input.project_id })}`,
		),
		"getEvaluationGateRun",
	);
}
export interface EvaluationRun {
	id: string;
	organization_id: string;
	project_id: string;
	evaluation_id: string;
	definition_version_id: string;
	dataset_version_id: string;
	dataset_id: string;
	experiment_id: string;
	benchmark_run_id: string | null;
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	requested_by_actor_id: string;
	idempotency_key: string;
	request_hash: string;
	resolved_inputs_hash: string;
	trigger_metadata: Record<string, unknown>;
	snapshot: {
		target: Record<string, unknown>;
		target_version: string;
		target_fingerprint: string;
		evaluator: Record<string, unknown>;
		evaluator_version: string;
		evaluator_fingerprint: string;
		execution_defaults: Record<string, unknown>;
		limits: Record<string, unknown>;
		execution_bounds: {
			max_active_runs_per_project: number;
			max_active_runs_per_actor: number;
			max_requested_sample_size: number;
			max_provider_calls: number;
		};
		thresholds: Record<string, unknown>;
		sampling: Record<string, unknown>;
		sample_identity: string;
		ordered_item_snapshot: Array<Record<string, unknown>>;
		resolved_inputs_hash: string;
	};
	created_at: string;
	updated_at: string;
	replayed: boolean;
}
export async function startEvaluationRun(input: {
	project_id: string;
	slug: string;
	definition_version: number;
	idempotency_key: string;
	trigger_metadata?: Record<string, string | number | boolean | null>;
}): Promise<EvaluationRun> {
	return responseJson(
		await authedFetch(
			`/v1/evaluations/${encodeURIComponent(input.slug)}/runs${buildQs({ project_id: input.project_id })}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": input.idempotency_key,
				},
				body: JSON.stringify({
					definition_version: input.definition_version,
					trigger_metadata: input.trigger_metadata ?? { source: "dashboard" },
				}),
			},
		),
		"startEvaluationRun",
	);
}
export interface EvaluationRunStatus {
	id: string;
	project_id: string;
	status: EvaluationRun["status"];
	counts: {
		total: number;
		pending: number;
		running: number;
		completed: number;
		failed: number;
		cancelled: number;
	};
	attempts: number;
	created_at: string;
	updated_at: string;
	terminal_reason: string | null;
	pinned_inputs: {
		definition_version_id: string;
		dataset_version_id: string;
		resolved_inputs_hash: string;
		target: JsonObject;
		target_version: string;
		target_fingerprint: string;
		evaluator: JsonObject;
		evaluator_version: string;
		evaluator_fingerprint: string;
		execution_defaults: JsonObject;
		thresholds: JsonObject;
		limits: JsonObject;
		execution_bounds: {
			max_active_runs_per_project: number;
			max_active_runs_per_actor: number;
			max_requested_sample_size: number;
			max_provider_calls: number;
		};
		sample: {
			strategy: string;
			sample_size: number;
			seed: number;
			selected_count: number;
			sample_identity: string;
		};
		provenance: {
			items: number;
			with_source_trace: number;
			with_source_observation: number;
		};
	};
	metrics: {
		evaluated: number;
		passed: number;
		failed: number;
		pass_rate: number | null;
		cost_usd: number | null;
		provider_calls_used: number;
		max_provider_calls: number;
		max_cost_usd: number | null;
		duration_ms: number | null;
		max_duration_seconds: number | null;
		score_counts: Record<string, number>;
	};
	evidence_policy: {
		retention: "project_policy";
		max_items: number;
		max_field_bytes: number;
		redaction: string;
	};
	items: Array<{
		task_id: string;
		item_key: string;
		position: number;
		status: EvaluationRun["status"];
		attempt_count: number;
		input: JsonObject;
		expected_output: JsonObject | null;
		output: JsonObject | null;
		scores: Record<string, number>;
		error_classification: string | null;
		error_message: string | null;
		cost_usd: number | null;
		evaluator_rationale: JsonObject | null;
		trace_id: string | null;
		agent_version: string | null;
		provenance: {
			source_trace_id: string | null;
			source_observation_id: string | null;
			evaluation_trace_id: string | null;
		};
		timing: {
			started_at: string | null;
			completed_at: string | null;
			duration_ms: number | null;
		};
		redaction: {
			applied: boolean;
			bounded: boolean;
			fields: string[];
			max_bytes: number;
		};
	}>;
	items_truncated: boolean;
}
export async function getEvaluationRunStatus(input: {
	project_id: string;
	id: string;
}): Promise<EvaluationRunStatus> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-runs/${encodeURIComponent(input.id)}${buildQs({ project_id: input.project_id })}`,
		),
		"getEvaluationRunStatus",
	);
}
export interface EvaluationRunEvidencePage {
	run_id: string;
	project_id: string;
	items: EvaluationRunStatus["items"];
	total: number;
	next_offset: number | null;
}
export async function getEvaluationRunEvidence(input: {
	project_id: string;
	id: string;
	limit?: number;
	offset?: number;
}): Promise<EvaluationRunEvidencePage> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-runs/${encodeURIComponent(input.id)}/evidence${buildQs({
				project_id: input.project_id,
				limit: input.limit,
				offset: input.offset,
			})}`,
		),
		"getEvaluationRunEvidence",
	);
}
export interface EvaluationRunSummary {
	id: string;
	project_id: string;
	evaluation_id: string;
	definition_version_id: string;
	dataset_version_id: string;
	status: EvaluationRun["status"];
	counts: EvaluationRunStatus["counts"];
	metrics: EvaluationRunStatus["metrics"];
	target_fingerprint: string;
	evaluator_fingerprint: string;
	sample_identity: string;
	created_at: string;
	updated_at: string;
	terminal_reason: string | null;
}
export async function listEvaluationRuns(input: {
	project_id: string;
	status?: EvaluationRun["status"];
	evaluation_id?: string;
	limit?: number;
	offset?: number;
}): Promise<{ items: EvaluationRunSummary[]; total: number }> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-runs${buildQs({
				project_id: input.project_id,
				status: input.status,
				evaluation_id: input.evaluation_id,
				limit: input.limit,
				offset: input.offset,
			})}`,
		),
		"listEvaluationRuns",
	);
}
export interface EvaluationRunCompare {
	run_ids: [string, string];
	comparable: boolean;
	differences: Array<{
		field:
			| "definition_version"
			| "dataset_version"
			| "target"
			| "evaluator"
			| "execution_defaults"
			| "sample"
			| "thresholds"
			| "terminal_reason"
			| "status";
		left: unknown;
		right: unknown;
	}>;
	refusal: {
		code:
			| "incompatible_inputs"
			| "non_success_terminal"
			| "unsupported_contract";
		message: string;
	} | null;
	metrics: {
		left: EvaluationRunStatus["metrics"];
		right: EvaluationRunStatus["metrics"];
		delta: {
			pass_rate: number | null;
			cost_usd: number | null;
			duration_ms: number | null;
		} | null;
	};
}
export async function compareEvaluationRuns(input: {
	project_id: string;
	run_ids: [string, string];
}): Promise<EvaluationRunCompare> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-runs/compare${buildQs({ project_id: input.project_id })}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ run_ids: input.run_ids }),
			},
		),
		"compareEvaluationRuns",
	);
}
export async function cancelEvaluationRun(input: {
	project_id: string;
	id: string;
}): Promise<EvaluationRunStatus> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-runs/${encodeURIComponent(input.id)}/cancel${buildQs({ project_id: input.project_id })}`,
			{ method: "POST" },
		),
		"cancelEvaluationRun",
	);
}
export async function retryEvaluationRun(input: {
	project_id: string;
	id: string;
}): Promise<EvaluationRunStatus> {
	return responseJson(
		await authedFetch(
			`/v1/evaluation-runs/${encodeURIComponent(input.id)}/retry${buildQs({ project_id: input.project_id })}`,
			{ method: "POST" },
		),
		"retryEvaluationRun",
	);
}
export function evaluationRunEventsUrl(input: {
	project_id: string;
	id: string;
}): string {
	return `/v1/evaluation-runs/${encodeURIComponent(input.id)}/events${buildQs({ project_id: input.project_id })}`;
}
export interface EvaluationLegacyLink {
	legacy_kind: "experiment" | "benchmark_suite";
	legacy_id: string;
	dataset_id: string | null;
	compatibility: "legacy_ad_hoc";
	created_at: string;
}
export async function listEvaluationLegacyLinks(
	project_id: string,
): Promise<{ items: EvaluationLegacyLink[] }> {
	return responseJson(
		await authedFetch(
			`/v1/evaluations/compatibility${buildQs({ project_id })}`,
		),
		"listEvaluationLegacyLinks",
	);
}
export async function listDatasetVersions(input: {
	project_id: string;
	slug: string;
}): Promise<{ items: DatasetVersionSummary[] }> {
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/versions${buildQs({ project_id: input.project_id })}`,
		),
		"listDatasetVersions",
	);
}
export async function getDatasetVersion(input: {
	project_id: string;
	slug: string;
	version: number;
}): Promise<DatasetVersion> {
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/versions/${input.version}${buildQs({ project_id: input.project_id })}`,
		),
		"getDatasetVersion",
	);
}
export interface DatasetDraftItem {
	id: string;
	item_key: string;
	validation_version: number;
	state: "draft" | "reviewed";
	input: JsonObject;
	expected_output: JsonObject | null;
	metadata: JsonObject;
	external_id: string | null;
	source_trace_id: string | null;
	source_observation_id: string | null;
	source_feedback_id: string | null;
	capture_context: {
		kind?: "trace" | "observation" | "feedback";
		redaction_applied?: boolean;
	};
	created_by: string | null;
	updated_by: string | null;
	reviewed_by: string | null;
	reviewed_at: string | null;
	position: number;
}
export async function getDatasetBySlug(input: {
	project_id: string;
	slug: string;
}): Promise<Dataset> {
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}${buildQs({ project_id: input.project_id })}`,
		),
		"getDatasetBySlug",
	);
}
export async function createDatasetDraft(input: {
	project_id: string;
	slug: string;
}): Promise<DatasetDraft> {
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/drafts${buildQs({ project_id: input.project_id })}`,
			{ method: "POST" },
		),
		"createDatasetDraft",
	);
}
export async function getDatasetDraft(input: {
	project_id: string;
	slug: string;
}): Promise<DatasetDraft> {
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/draft${buildQs({ project_id: input.project_id })}`,
		),
		"getDatasetDraft",
	);
}
export async function updateDatasetMetadata(input: {
	project_id: string;
	slug: string;
	revision: number;
	name?: string;
	description?: string | null;
	tags?: string[];
}): Promise<Dataset> {
	const { project_id, slug, revision, ...body } = input;
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(slug)}${buildQs({ project_id })}`,
			{
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					"if-match": `"${revision}"`,
				},
				body: JSON.stringify(body),
			},
		),
		"updateDatasetMetadata",
	);
}
export async function upsertDatasetDraftItem(input: {
	project_id: string;
	slug: string;
	item_key: string;
	revision: number;
	input: JsonObject;
	expected_output?: JsonObject | null;
	metadata?: JsonObject;
	external_id?: string | null;
	source_trace_id?: string | null;
	source_observation_id?: string | null;
}): Promise<DatasetDraftItem> {
	const { project_id, slug, item_key, revision, ...body } = input;
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(slug)}/draft/items/${encodeURIComponent(item_key)}${buildQs({ project_id })}`,
			{
				method: "PUT",
				headers: {
					"content-type": "application/json",
					"if-match": `"${revision}"`,
				},
				body: JSON.stringify(body),
			},
		),
		"upsertDatasetDraftItem",
	);
}
export async function validateDatasetDraft(input: {
	project_id: string;
	slug: string;
}): Promise<{
	validation_version: number;
	valid: boolean;
	errors: Array<{
		item_id: string | null;
		item_key: string | null;
		field: string;
		code: string;
		message: string;
	}>;
}> {
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/draft/validate${buildQs({ project_id: input.project_id })}`,
			{ method: "POST" },
		),
		"validateDatasetDraft",
	);
}
export async function importDatasetDraftItems(input: {
	project_id: string;
	slug: string;
	revision?: number;
	idempotency_key: string;
	items: Array<{
		item_key: string;
		input: JsonObject;
		expected_output?: JsonObject | null;
		metadata?: JsonObject;
		external_id?: string | null;
		source_trace_id?: string | null;
		source_observation_id?: string | null;
	}>;
}): Promise<{
	items: DatasetDraftItem[];
	validation_version: number;
	revision: number;
	idempotent: boolean;
}> {
	const { project_id, slug, revision, idempotency_key, items } = input;
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(slug)}/draft/import${buildQs({ project_id })}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": idempotency_key,
					...(revision === undefined ? {} : { "if-match": `"${revision}"` }),
				},
				body: JSON.stringify({ items }),
			},
		),
		"importDatasetDraftItems",
	);
}
export async function captureDatasetDraftItem(input: {
	project_id: string;
	slug: string;
	revision?: number;
	idempotency_key: string;
	item_key?: string;
	external_id?: string | null;
	source_trace_id: string;
	source_observation_id?: string;
}): Promise<{
	item: DatasetDraftItem | null;
	validation_version: number;
	revision: number;
	idempotent: boolean;
}> {
	const { project_id, slug, revision, idempotency_key, ...body } = input;
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(slug)}/draft/capture${buildQs({ project_id })}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": idempotency_key,
					...(revision === undefined ? {} : { "if-match": `"${revision}"` }),
				},
				body: JSON.stringify(body),
			},
		),
		"captureDatasetDraftItem",
	);
}
export async function reorderDatasetDraftItems(input: {
	project_id: string;
	slug: string;
	revision: number;
	item_ids: string[];
}): Promise<{
	validation_version: number;
	revision: number;
	idempotent: false;
}> {
	const { project_id, slug, revision, item_ids } = input;
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(slug)}/draft/items/order${buildQs({ project_id })}`,
			{
				method: "PUT",
				headers: {
					"content-type": "application/json",
					"if-match": `"${revision}"`,
				},
				body: JSON.stringify({ item_ids }),
			},
		),
		"reorderDatasetDraftItems",
	);
}
export async function reviewDatasetDraftItem(input: {
	project_id: string;
	slug: string;
	item_id: string;
	revision: number;
}): Promise<DatasetDraftItem> {
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/draft/items/${encodeURIComponent(input.item_id)}/review${buildQs({ project_id: input.project_id })}`,
			{
				method: "POST",
				headers: { "if-match": `"${input.revision}"` },
			},
		),
		"reviewDatasetDraftItem",
	);
}
export async function listDatasetDraftItemRevisions(input: {
	project_id: string;
	slug: string;
	item_id: string;
}): Promise<{
	items: Array<
		DatasetDraftItem & {
			item_revision: number;
			action: "upserted" | "captured" | "imported" | "reviewed" | "reordered";
			actor_username: string;
			created_at: string;
		}
	>;
}> {
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/draft/items/${encodeURIComponent(input.item_id)}/revisions${buildQs({ project_id: input.project_id })}`,
		),
		"listDatasetDraftItemRevisions",
	);
}
export async function discardDatasetDraft(input: {
	project_id: string;
	slug: string;
}): Promise<void> {
	await responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/draft/discard${buildQs({ project_id: input.project_id })}`,
			{ method: "POST" },
		),
		"discardDatasetDraft",
	);
}
export async function publishDatasetDraft(input: {
	project_id: string;
	slug: string;
	revision: number;
}): Promise<{ version: number; item_count: number }> {
	return responseJson(
		await authedFetch(
			`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/draft/publish${buildQs({ project_id: input.project_id })}`,
			{ method: "POST", headers: { "if-match": `"${input.revision}"` } },
		),
		"publishDatasetDraft",
	);
}
export async function archiveDataset(input: {
	project_id: string;
	slug: string;
	revision: number;
}): Promise<void> {
	const response = await authedFetch(
		`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}${buildQs({ project_id: input.project_id })}`,
		{ method: "DELETE", headers: { "if-match": `"${input.revision}"` } },
	);
	if (!response.ok) await responseJson<never>(response, "archiveDataset");
}
export async function restoreDataset(input: {
	project_id: string;
	slug: string;
	revision: number;
}): Promise<void> {
	const response = await authedFetch(
		`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/restore${buildQs({ project_id: input.project_id })}`,
		{ method: "POST", headers: { "if-match": `"${input.revision}"` } },
	);
	if (!response.ok) await responseJson<never>(response, "restoreDataset");
}
export async function tombstoneDataset(input: {
	project_id: string;
	slug: string;
	revision: number;
	confirmation_slug: string;
}): Promise<void> {
	const response = await authedFetch(
		`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/tombstone${buildQs({ project_id: input.project_id })}`,
		{
			method: "DELETE",
			headers: {
				"content-type": "application/json",
				"if-match": `"${input.revision}"`,
			},
			body: JSON.stringify({ confirmation_slug: input.confirmation_slug }),
		},
	);
	if (!response.ok) await responseJson<never>(response, "tombstoneDataset");
}
export async function exportDataset(input: {
	project_id: string;
	slug: string;
	format: "csv" | "jsonl";
	representation: "draft" | "version";
	version?: number;
}): Promise<{ body: string; content_type: string; filename: string }> {
	const response = await authedFetch(
		`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/export${buildQs({
			project_id: input.project_id,
			format: input.format,
			representation: input.representation,
			version: input.version,
		})}`,
	);
	if (!response.ok) return responseJson<never>(response, "exportDataset");
	const disposition = response.headers.get("content-disposition") ?? "";
	const filename =
		disposition.match(/filename="([^"]+)"/)?.[1] ?? "dataset-export";
	return {
		body: await response.text(),
		content_type: response.headers.get("content-type") ?? "text/plain",
		filename,
	};
}
export async function deleteDatasetDraftItem(input: {
	project_id: string;
	slug: string;
	item_id: string;
	revision: number;
}): Promise<void> {
	const response = await authedFetch(
		`/v1/datasets/by-slug/${encodeURIComponent(input.slug)}/draft/items/${encodeURIComponent(input.item_id)}${buildQs({ project_id: input.project_id })}`,
		{ method: "DELETE", headers: { "if-match": `"${input.revision}"` } },
	);
	if (!response.ok) await responseJson(response, "deleteDatasetDraftItem");
}
export interface DatasetItem {
	id: string;
	dataset_id: string;
	item_key: string | null;
	validation_version: number;
	state: "draft" | "reviewed";
	input: JsonObject;
	expected_output: JsonObject | null;
	metadata: JsonObject;
	external_id: string | null;
	source_trace_id: string | null;
	source_observation_id: string | null;
	source_feedback_id: string | null;
	capture_context: {
		kind?: "trace" | "observation" | "feedback";
		redaction_applied?: boolean;
	};
	created_by: string | null;
	updated_by: string | null;
	reviewed_by: string | null;
	reviewed_at: string | null;
	created_at: string;
}
export interface Experiment {
	id: string;
	project_id: string;
	dataset_id: string;
	resolved_dataset_version_id: string | null;
	dataset_input_binding: "versioned" | "legacy_unversioned";
	name: string | null;
	status: "pending" | "running" | "completed" | "failed" | "cancelled";
	created_at: string;
	updated_at: string;
}
export interface Feedback {
	id: string;
	project_id: string;
	trace_id: string;
	observation_id: string | null;
	target_type: "trace" | "observation";
	value: 1 | -1;
	sentiment: "positive" | "negative";
	reason: string | null;
	comment: string | null;
	status: "new" | "reviewed" | "dismissed" | "added_to_dataset";
	note: string | null;
	dataset_id: string | null;
	dataset_item_id: string | null;
	dataset_draft_item_id: string | null;
	created_at: string;
	updated_at: string;
}
export async function listDatasets(
	project_id: string,
	include_archived = false,
): Promise<{ items: Dataset[]; total: number }> {
	return responseJson(
		await authedFetch(
			`/v1/datasets${buildQs({
				project_id,
				include_archived: include_archived ? "true" : undefined,
			})}`,
		),
		"listDatasets",
	);
}
export async function createDataset(input: {
	project_id: string;
	name: string;
	description?: string;
}): Promise<Dataset> {
	return responseJson(
		await authedFetch("/v1/datasets", jsonRequest(input)),
		"createDataset",
	);
}
export async function getDataset(input: {
	project_id: string;
	id: string;
}): Promise<Dataset> {
	return responseJson(
		await authedFetch(
			`/v1/datasets/${encodeURIComponent(input.id)}${buildQs({ project_id: input.project_id })}`,
		),
		"getDataset",
	);
}
export async function listDatasetItems(input: {
	project_id: string;
	id: string;
	signal?: AbortSignal;
}): Promise<{ items: DatasetItem[] }> {
	return responseJson(
		await authedFetch(
			`/v1/datasets/${encodeURIComponent(input.id)}/items${buildQs({ project_id: input.project_id })}`,
			{ signal: input.signal },
		),
		"listDatasetItems",
	);
}
export async function listPublishedDatasetItems(input: {
	project_id: string;
	id: string;
}): Promise<{ items: DatasetItem[] }> {
	return responseJson(
		await authedFetch(
			`/v1/datasets/${encodeURIComponent(input.id)}/published-items${buildQs({ project_id: input.project_id })}`,
		),
		"listPublishedDatasetItems",
	);
}
export async function addDatasetItem(input: {
	project_id: string;
	dataset_id: string;
	input: JsonObject;
	expected_output?: JsonObject | null;
	metadata?: JsonObject;
	source_trace_id?: string;
	source_observation_id?: string;
}): Promise<DatasetItem> {
	const { dataset_id, ...body } = input;
	return responseJson(
		await authedFetch(
			`/v1/datasets/${encodeURIComponent(dataset_id)}/items`,
			jsonRequest(body),
		),
		"addDatasetItem",
	);
}
export async function deleteDatasetItem(input: {
	project_id: string;
	dataset_id: string;
	item_id: string;
}): Promise<void> {
	const response = await authedFetch(
		`/v1/datasets/${encodeURIComponent(input.dataset_id)}/items/${encodeURIComponent(input.item_id)}${buildQs({ project_id: input.project_id })}`,
		{ method: "DELETE" },
	);
	if (!response.ok) await responseJson<never>(response, "deleteDatasetItem");
}
export async function listExperiments(
	project_id: string,
): Promise<{ items: Experiment[]; total: number }> {
	return responseJson(
		await authedFetch(`/v1/experiments${buildQs({ project_id })}`),
		"listExperiments",
	);
}
export async function createExperiment(input: {
	project_id: string;
	dataset_id: string;
	evaluation_id: string;
	definition_version: number;
	idempotency_key: string;
}): Promise<Experiment> {
	const {
		project_id,
		dataset_id,
		evaluation_id,
		definition_version,
		idempotency_key,
	} = input;
	return responseJson(
		await authedFetch(
			"/v1/experiments",
			jsonRequest({
				project_id,
				dataset_id,
				evaluation_id,
				definition_version,
				idempotency_key,
			}),
		),
		"createExperiment",
	);
}
export async function getExperiment(input: {
	project_id: string;
	id: string;
}): Promise<Experiment> {
	return responseJson(
		await authedFetch(
			`/v1/experiments/${encodeURIComponent(input.id)}${buildQs({ project_id: input.project_id })}`,
		),
		"getExperiment",
	);
}
export async function experimentResults(input: {
	project_id: string;
	id: string;
}): Promise<{
	items: Array<{
		id: string;
		dataset_item_id: string;
		output: JsonObject | null;
		scores: Record<string, number>;
		duration_ms: number | null;
		cost_usd: number | null;
		error_classification: string | null;
		error_message: string | null;
		evaluator_rationale: JsonObject | null;
		trace_id: string | null;
		status: string;
	}>;
}> {
	return responseJson(
		await authedFetch(
			`/v1/experiments/${encodeURIComponent(input.id)}/results${buildQs({ project_id: input.project_id })}`,
		),
		"experimentResults",
	);
}
export function experimentEventsUrl(input: {
	project_id: string;
	id: string;
}): string {
	return `/v1/experiments/${encodeURIComponent(input.id)}/events${buildQs({ project_id: input.project_id })}`;
}
export async function experimentSummary(input: {
	project_id: string;
	id: string;
}): Promise<{
	experiment_id: string;
	total: number;
	passed: number;
	failed: number;
	pass_rate: number;
	avg_duration_ms: number | null;
}> {
	return responseJson(
		await authedFetch(
			`/v1/experiments/${encodeURIComponent(input.id)}/summary${buildQs({ project_id: input.project_id })}`,
		),
		"experimentSummary",
	);
}
export async function cancelExperiment(input: {
	project_id: string;
	id: string;
}): Promise<Experiment> {
	return responseJson(
		await authedFetch(
			`/v1/experiments/${encodeURIComponent(input.id)}/cancel${buildQs({ project_id: input.project_id })}`,
			{ method: "POST" },
		),
		"cancelExperiment",
	);
}
export async function listFeedback(input: {
	project_id: string;
	sentiment?: string;
	status?: string;
	target_type?: string;
}): Promise<{ items: Feedback[]; total: number }> {
	return responseJson(
		await authedFetch(`/v1/feedback${buildQs(input)}`),
		"listFeedback",
	);
}
export async function getOwnFeedback(input: {
	project_id: string;
	trace_id: string;
	observation_id?: string;
}): Promise<Feedback | null> {
	return responseJson(
		await authedFetch(`/v1/feedback/mine${buildQs(input)}`),
		"getOwnFeedback",
	);
}
export async function createFeedback(input: {
	project_id: string;
	trace_id: string;
	observation_id?: string;
	value: 1 | -1;
	metadata: JsonObject;
	idempotency_key?: string;
}): Promise<Feedback> {
	const { idempotency_key, ...body } = input;
	return responseJson(
		await authedFetch("/v1/feedback", {
			...jsonRequest(body),
			headers: {
				"content-type": "application/json",
				"idempotency-key": idempotency_key ?? crypto.randomUUID(),
			},
		}),
		"createFeedback",
	);
}
export async function promoteFeedback(input: {
	project_id: string;
	id: string;
	dataset_id: string;
	item_key?: string;
	idempotency_key?: string;
}): Promise<Feedback> {
	const { project_id, id, idempotency_key, ...body } = input;
	return responseJson(
		await authedFetch(
			`/v1/feedback/${encodeURIComponent(id)}/promote${buildQs({ project_id })}`,
			{
				...jsonRequest(body),
				headers: {
					"content-type": "application/json",
					"idempotency-key": idempotency_key ?? crypto.randomUUID(),
				},
			},
		),
		"promoteFeedback",
	);
}
export async function reviewFeedback(input: {
	project_id: string;
	id: string;
	status: string;
	note?: string;
	dataset_id?: string;
	dataset_item_id?: string;
}): Promise<Feedback> {
	const { project_id, id, ...body } = input;
	return responseJson(
		await authedFetch(
			`/v1/feedback/${encodeURIComponent(id)}/review${buildQs({ project_id })}`,
			jsonRequest(body),
		),
		"reviewFeedback",
	);
}

export interface GovernancePolicyVersion {
	id: string;
	version: number;
	retention: Partial<Record<"traces" | "datasets" | "feedback", number>>;
	redaction: { mode: "none" | "all_text"; keys: string[] };
	content_hash: string;
	created_by: string;
	created_at: string;
	approved_by: string | null;
	approved_by_username: string | null;
	approved_at: string | null;
}
export async function getEffectiveGovernancePolicy(
	project_id: string,
): Promise<{ policy: GovernancePolicyVersion | null }> {
	return responseJson(
		await authedFetch(`/v1/governance/policy${buildQs({ project_id })}`),
		"getEffectiveGovernancePolicy",
	);
}
export async function listGovernancePolicyHistory(
	project_id: string,
): Promise<{ items: GovernancePolicyVersion[] }> {
	return responseJson(
		await authedFetch(
			`/v1/governance/policy/history${buildQs({ project_id })}`,
		),
		"listGovernancePolicyHistory",
	);
}
export async function createGovernancePolicyDraft(input: {
	project_id: string;
	retention: GovernancePolicyVersion["retention"];
	redaction: GovernancePolicyVersion["redaction"];
}): Promise<{ policy: GovernancePolicyVersion; created: boolean }> {
	const response = await authedFetch(
		"/v1/governance/policy/drafts",
		jsonRequest(input),
	);
	return {
		...(await responseJson(response, "createGovernancePolicyDraft")),
		created: response.status === 201,
	};
}
export async function approveGovernancePolicy(input: {
	project_id: string;
	id: string;
}): Promise<{ policy: GovernancePolicyVersion }> {
	return responseJson(
		await authedFetch(
			`/v1/governance/policy/${encodeURIComponent(input.id)}/approve${buildQs({ project_id: input.project_id })}`,
			{ method: "POST" },
		),
		"approveGovernancePolicy",
	);
}
export async function previewGovernanceRetention(project_id: string): Promise<{
	policy_version_id: string;
	counts: Record<string, number>;
	preview_id: string;
	preview_expires_at: string;
}> {
	return responseJson(
		await authedFetch(
			"/v1/governance/retention/preview",
			jsonRequest({ project_id }),
		),
		"previewGovernanceRetention",
	);
}
export async function runGovernanceRetention(input: {
	project_id: string;
	policy_version_id: string;
	preview_id: string;
	batch_size: number;
}): Promise<{
	policy_version_id: string;
	counts: Record<string, number>;
	run_id: string;
	status: "completed";
}> {
	return responseJson(
		await authedFetch("/v1/governance/retention/runs", jsonRequest(input)),
		"runGovernanceRetention",
	);
}
export interface GovernanceRetentionRun {
	id: string;
	policy_version_id: string;
	status: "running" | "completed" | "failed";
	counts: Record<string, number>;
	started_at: string;
	completed_at: string | null;
	duration_ms: number | null;
}
export async function listGovernanceRetentionRuns(
	project_id: string,
): Promise<{ items: GovernanceRetentionRun[] }> {
	return responseJson(
		await authedFetch(
			`/v1/governance/retention/runs${buildQs({ project_id })}`,
		),
		"listGovernanceRetentionRuns",
	);
}

export interface Project {
	id: string;
	name: string;
	slug: string;
	status: "active" | "archived" | "deleting";
	created_at: string;
	archived_at: string | null;
	project_role: "admin" | "user" | "read_only";
	can_manage: boolean;
	can_govern: boolean;
	is_default: boolean;
}

export interface CurrentActor {
	actor_subject: string;
	actor_id: string;
	organization_id: string;
	organization_role: "admin" | "user" | "read_only";
	can_recover_admin: boolean;
	effective_organization_role_id: "organization:admin" | "organization:user";
	default_project_id: string;
	projects: Project[];
}

export interface ProjectListResponse {
	items: Project[];
	total: number;
}

export type OrganizationUsageRange = "24h" | "7d" | "30d" | "90d";
export interface OrganizationUsageCounts {
	traces: number;
	observations: number;
	observations_by_type: Record<
		"span" | "event" | "generation" | "tool",
		number
	>;
}
export interface OrganizationUsageProject extends OrganizationUsageCounts {
	id: string;
	name: string;
	slug: string;
	status: "active" | "archived";
}
export interface OrganizationUsageDashboard {
	range: OrganizationUsageRange;
	from: string;
	to: string;
	projects: OrganizationUsageProject[];
	totals: OrganizationUsageCounts;
	series: Array<OrganizationUsageCounts & { bucket_start: string }>;
}
export async function getOrganizationUsage(
	range: OrganizationUsageRange = "30d",
): Promise<OrganizationUsageDashboard> {
	return responseJson<OrganizationUsageDashboard>(
		await authedFetch(`/v1/organization/usage${buildQs({ range })}`),
		"getOrganizationUsage",
	);
}

export async function listProjects(
	includeArchived = false,
): Promise<ProjectListResponse> {
	return responseJson<ProjectListResponse>(
		await authedFetch(
			`/v1/projects${buildQs({ include_archived: includeArchived ? "true" : undefined })}`,
		),
		"listProjects",
	);
}
export async function createProject(input: {
	name: string;
	slug: string;
}): Promise<Project> {
	return responseJson<Project>(
		await authedFetch("/v1/projects", jsonRequest(input)),
		"createProject",
	);
}
export async function updateProject(input: {
	id: string;
	name?: string;
	slug?: string;
}): Promise<Project> {
	const { id, ...body } = input;
	return responseJson<Project>(
		await authedFetch(`/v1/projects/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		"updateProject",
	);
}
export async function setDefaultProject(project_id: string): Promise<Project> {
	return responseJson(
		await authedFetch("/v1/organizations/current/default-project", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ project_id }),
		}),
		"setDefaultProject",
	);
}
export async function deleteProject(input: {
	id: string;
	confirmation_name: string;
}): Promise<void> {
	const response = await authedFetch(
		`/v1/projects/${encodeURIComponent(input.id)}`,
		{
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ confirmation_name: input.confirmation_name }),
		},
	);
	if (!response.ok) await responseJson<never>(response, "deleteProject");
}
export interface ProjectDeletionStatus {
	status:
		| "pending"
		| "traces_cleaned"
		| "clickhouse_cleaned"
		| "failed"
		| "completed";
	traces_cleaned_at: string | null;
	observations_cleaned_at: string | null;
	completed_at: string | null;
	attempt_count: number;
}
export async function getProjectDeletionStatus(
	projectId: string,
): Promise<ProjectDeletionStatus> {
	return responseJson(
		await authedFetch(`/v1/projects/${encodeURIComponent(projectId)}/deletion`),
		"getProjectDeletionStatus",
	);
}
export async function archiveProject(id: string): Promise<Project> {
	return responseJson<Project>(
		await authedFetch(`/v1/projects/${encodeURIComponent(id)}/archive`, {
			method: "POST",
		}),
		"archiveProject",
	);
}
export async function restoreProject(id: string): Promise<Project> {
	return responseJson<Project>(
		await authedFetch(`/v1/projects/${encodeURIComponent(id)}/restore`, {
			method: "POST",
		}),
		"restoreProject",
	);
}
export async function getCurrentActor(): Promise<CurrentActor> {
	return responseJson(await authedFetch("/v1/me"), "getCurrentActor");
}

export interface AdminActor {
	actor_id: string;
	username: string | null;
	organization_role: "admin" | "user" | "read_only" | null;
	created_at: string;
}

export async function listAdminActors(): Promise<{ items: AdminActor[] }> {
	return responseJson(await authedFetch("/v1/admin/actors"), "listAdminActors");
}

export async function setAdminActorRole(input: {
	actorId: string;
	role: Exclude<AdminActor["organization_role"], null>;
}): Promise<AdminActor> {
	return responseJson(
		await authedFetch(
			`/v1/admin/actors/${encodeURIComponent(input.actorId)}/role`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ role: input.role }),
			},
		),
		"setAdminActorRole",
	);
}

export async function recoverAdmin(): Promise<AdminActor> {
	return responseJson(
		await authedFetch("/v1/admin/recovery", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ confirmation: "RESTORE ADMIN" }),
		}),
		"recoverAdmin",
	);
}

export type PromptRole = "system" | "user";

export interface PromptMessage {
	role: PromptRole;
	content: string;
}

export interface PromptVersion {
	id: string;
	version: number;
	messages: PromptMessage[];
	model: string | null;
	settings: JsonObject;
	change_summary: string;
	created_by: string;
	created_by_username: string;
	created_at: string;
	content_hash: string;
	diff: string | null;
}

export interface Prompt extends PromptVersion {
	project_id: string;
	name: string;
	description: string | null;
}

export interface PromptListResponse {
	items: Prompt[];
	total: number;
}

export interface PromptVersionListResponse {
	items: PromptVersion[];
}

export interface CreatePromptInput {
	project_id: string;
	name: string;
	description?: string | null;
	messages: PromptMessage[];
	model?: string | null;
	settings?: JsonObject;
}

export interface CreatePromptVersionInput {
	project_id: string;
	slug: string;
	base_version: number;
	messages: PromptMessage[];
	model?: string | null;
	settings?: JsonObject;
	change_summary: string;
}

export interface RenderPromptInput {
	project_id: string;
	slug: string;
	version?: number;
	data: JsonObject;
}

export interface PromptRenderResponse {
	id: string;
	version: number;
	content_hash: string;
	messages: PromptMessage[];
	warnings: Array<{ code: "MISSING_VARIABLE"; role: PromptRole; path: string }>;
}

export interface PromptPreviewResponse {
	messages: PromptMessage[];
	warnings: Array<{ code: "MISSING_VARIABLE"; role: PromptRole; path: string }>;
}

export interface PromptProvenanceStatusResponse {
	status: "active" | "deleted" | "unknown";
}

export interface OptimizationJob {
	id: string;
	status:
		| "queued"
		| "preparing"
		| "optimizing"
		| "evaluating"
		| "completed"
		| "stopped"
		| "failed";
	result_version: number | null;
	error_message: string | null;
	metric_calls_used: number | null;
	source_version?: number;
	target?: PromptRole;
	budget?: { max_metric_calls?: number };
	dataset?: OptimizationDatasetSummary;
	candidate_content?: string | null;
	evidence?: OptimizationEvidence | null;
	promotion_status?: OptimizationPromotionStatus;
	promotion_reason?: string | null;
	promoted_at?: string | null;
	created_at?: string;
	updated_at?: string;
	completed_at?: string | null;
}

export interface OptimizationActivity {
	id: string;
	prompt_slug: string;
	source_version: number;
	target: PromptRole;
	status: Exclude<
		OptimizationJob["status"],
		"completed" | "stopped" | "failed"
	>;
	created_at: string;
	updated_at: string;
}

export interface OptimizationActivityListResponse {
	items: OptimizationActivity[];
}

export interface OptimizationExample {
	input: string;
	answer: string;
	additional_context?: JsonObject;
}

export interface OptimizationDataset {
	version: 1;
	rubric: string;
	training_examples: OptimizationExample[];
	validation_examples: OptimizationExample[];
}

export interface OptimizationDatasetSummary {
	version: 0 | 1;
	rubric: string;
	training_example_count: number;
	validation_example_count: number;
}

export interface OptimizationEvidence {
	metric: "default_adapter.expected_answer_contains";
	rubric: string;
	training: { sample_count: number; score: number | null };
	validation: {
		sample_count: number;
		score: number | null;
		baseline_score: number | null;
		held_out: true;
	};
	leakage: {
		status: "not_run" | "passed" | "failed";
		reason:
			| "expected_answer_full_match"
			| "expected_answer_material_span"
			| null;
	};
}

export type OptimizationPromotionStatus =
	| "pending"
	| "auto_promoted"
	| "review_required"
	| "blocked"
	| "reviewed_promoted"
	| "legacy";

export interface OptimizationEvent {
	id: number;
	status: OptimizationJob["status"];
	detail: JsonObject;
	created_at: string;
}

export function promptOptimizationEventsUrl(input: {
	project_id: string;
	id: string;
}): string {
	return `/v1/prompt-optimizations/${encodeURIComponent(input.id)}/events${buildQs({ project_id: input.project_id })}`;
}

export async function startPromptOptimization(input: {
	project_id: string;
	slug: string;
	source_version: number;
	target: "system";
	evaluator: JsonObject;
	dataset: OptimizationDataset;
	model_config: JsonObject;
	budget: { max_metric_calls: number };
}): Promise<OptimizationJob> {
	return responseJson<OptimizationJob>(
		await authedFetch("/v1/prompt-optimizations", jsonRequest(input)),
		"startPromptOptimization",
	);
}

export async function promotePromptOptimization(input: {
	project_id: string;
	id: string;
}): Promise<OptimizationJob> {
	return responseJson<OptimizationJob>(
		await authedFetch(
			`/v1/prompt-optimizations/${encodeURIComponent(input.id)}/promote${buildQs({ project_id: input.project_id })}`,
			{ method: "POST" },
		),
		"promotePromptOptimization",
	);
}

export async function getPromptOptimization(input: {
	project_id: string;
	id: string;
	signal?: AbortSignal;
}): Promise<OptimizationJob> {
	return responseJson<OptimizationJob>(
		await authedFetch(
			`/v1/prompt-optimizations/${encodeURIComponent(input.id)}${buildQs({ project_id: input.project_id })}`,
			{ signal: input.signal },
		),
		"getPromptOptimization",
	);
}

export async function getActivePromptOptimization(input: {
	project_id: string;
	slug: string;
}): Promise<OptimizationJob | null> {
	return responseJson<OptimizationJob | null>(
		await authedFetch(`/v1/prompt-optimizations/active${buildQs(input)}`),
		"getActivePromptOptimization",
	);
}

export async function getLatestPromptOptimization(input: {
	project_id: string;
	slug: string;
	signal?: AbortSignal;
}): Promise<OptimizationJob | null> {
	return responseJson<OptimizationJob | null>(
		await authedFetch(
			`/v1/prompt-optimizations/latest${buildQs({ project_id: input.project_id, slug: input.slug })}`,
			{ signal: input.signal },
		),
		"getLatestPromptOptimization",
	);
}

export async function listActivePromptOptimizationActivities(input: {
	project_id: string;
	signal?: AbortSignal;
}): Promise<OptimizationActivityListResponse> {
	return responseJson<OptimizationActivityListResponse>(
		await authedFetch(
			`/v1/prompt-optimizations/activities${buildQs({ project_id: input.project_id })}`,
			{ signal: input.signal },
		),
		"listActivePromptOptimizationActivities",
	);
}

export async function stopPromptOptimization(input: {
	project_id: string;
	id: string;
}): Promise<OptimizationJob> {
	return responseJson<OptimizationJob>(
		await authedFetch(
			`/v1/prompt-optimizations/${encodeURIComponent(input.id)}/stop${buildQs({ project_id: input.project_id })}`,
			{ method: "POST" },
		),
		"stopPromptOptimization",
	);
}

export async function listPrompts(
	projectId: string,
): Promise<PromptListResponse> {
	return responseJson<PromptListResponse>(
		await authedFetch(`/v1/prompts${buildQs({ project_id: projectId })}`),
		"listPrompts",
	);
}

export async function createPrompt(input: CreatePromptInput): Promise<Prompt> {
	return responseJson<Prompt>(
		await authedFetch("/v1/prompts", jsonRequest(input)),
		"createPrompt",
	);
}

export async function getPrompt(input: {
	project_id: string;
	slug: string;
	version?: number;
}): Promise<Prompt> {
	return responseJson<Prompt>(
		await authedFetch(
			`/v1/prompts/${encodeURIComponent(input.slug)}${buildQs({ project_id: input.project_id, version: input.version })}`,
		),
		"getPrompt",
	);
}

export async function listPromptVersions(input: {
	project_id: string;
	slug: string;
}): Promise<PromptVersionListResponse> {
	return responseJson<PromptVersionListResponse>(
		await authedFetch(
			`/v1/prompts/${encodeURIComponent(input.slug)}/versions${buildQs({ project_id: input.project_id })}`,
		),
		"listPromptVersions",
	);
}

export async function createPromptVersion(
	input: CreatePromptVersionInput,
): Promise<PromptVersion> {
	const { project_id, slug, ...body } = input;
	return responseJson<PromptVersion>(
		await authedFetch(
			`/v1/prompts/${encodeURIComponent(slug)}/versions${buildQs({ project_id })}`,
			jsonRequest(body),
		),
		"createPromptVersion",
	);
}

export async function rollbackLatestPromptVersion(input: {
	project_id: string;
	slug: string;
}): Promise<Prompt> {
	return responseJson<Prompt>(
		await authedFetch(
			`/v1/prompts/${encodeURIComponent(input.slug)}/versions/rollback${buildQs({ project_id: input.project_id })}`,
			{ method: "POST" },
		),
		"rollbackLatestPromptVersion",
	);
}

export async function renderPrompt(
	input: RenderPromptInput,
): Promise<PromptRenderResponse> {
	const { project_id, slug, version, data } = input;
	return responseJson<PromptRenderResponse>(
		await authedFetch(
			`/v1/prompts/${encodeURIComponent(slug)}/render${buildQs({ project_id, version })}`,
			jsonRequest({ data }),
		),
		"renderPrompt",
	);
}

export async function previewPrompt(input: {
	project_id: string;
	messages: PromptMessage[];
	data: JsonObject;
}): Promise<PromptPreviewResponse> {
	return responseJson<PromptPreviewResponse>(
		await authedFetch("/v1/prompts/preview", jsonRequest(input)),
		"previewPrompt",
	);
}

export async function deletePrompt(input: {
	project_id: string;
	slug: string;
	confirmation: string;
}): Promise<void> {
	const { project_id, slug, confirmation } = input;
	const response = await authedFetch(
		`/v1/prompts/${encodeURIComponent(slug)}${buildQs({ project_id })}`,
		{
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ confirmation }),
		},
	);
	if (!response.ok) await responseJson<never>(response, "deletePrompt");
}

export async function getPromptProvenance(input: {
	project_id: string;
	id: string;
	version: number;
	content_hash: string;
}): Promise<PromptProvenanceStatusResponse> {
	const { id, ...query } = input;
	return responseJson<PromptProvenanceStatusResponse>(
		await authedFetch(
			`/v1/prompt-provenance/${encodeURIComponent(id)}${buildQs(query)}`,
		),
		"getPromptProvenance",
	);
}

export interface TraceRow {
	trace_id: string;
	project_id: string;
	name: string;
	start_time: string;
	end_time: string | null;
	duration_ms: number | null;
	status: "ok" | "error";
	user_id: string;
	session_id: string;
	agent_id: string;
	agent_version: string;
	env: string;
	tags: string[];
	input_text: string;
	output_text: string;
	scores_summary: string;
	input_retained_truncated?: boolean;
	output_retained_truncated?: boolean;
	input_excerpt_truncated?: boolean;
	output_excerpt_truncated?: boolean;
}

export interface OtlpAttribute {
	key: string;
	value?: Record<string, unknown> | unknown[];
}

export interface PromptProvenance {
	id: string;
	version: number;
	content_hash: string;
}

export interface ObservationMetadata {
	schema_version: 1;
	attributes: OtlpAttribute[];
	prompt_provenance: PromptProvenance | null;
	truncated?: boolean;
}

export type ObservationMetadataInput =
	| ObservationMetadata
	| string
	| null
	| undefined;

const PROMPT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function emptyObservationMetadata(): ObservationMetadata {
	return { schema_version: 1, attributes: [], prompt_provenance: null };
}

export function normalizeObservationMetadata(
	raw: ObservationMetadataInput,
	isGeneration = true,
): ObservationMetadata {
	const parsed = typeof raw === "string" ? parseMetadataString(raw) : raw;
	if (Array.isArray(parsed)) {
		return isAttributeArray(parsed)
			? {
					schema_version: 1,
					attributes: sanitizeMetadataAttributes(parsed),
					prompt_provenance: null,
				}
			: emptyObservationMetadata();
	}
	if (!isMetadataEnvelope(parsed)) return emptyObservationMetadata();
	return {
		schema_version: 1,
		attributes: sanitizeMetadataAttributes(parsed.attributes),
		...(parsed.truncated ? { truncated: true } : {}),
		prompt_provenance:
			isGeneration && isPromptProvenance(parsed.prompt_provenance)
				? parsed.prompt_provenance
				: null,
	};
}

function parseMetadataString(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOtlpAttribute(value: unknown): value is OtlpAttribute {
	return (
		isRecord(value) &&
		typeof value.key === "string" &&
		(value.value === undefined ||
			isRecord(value.value) ||
			Array.isArray(value.value))
	);
}

function isAttributeArray(value: unknown): value is OtlpAttribute[] {
	return Array.isArray(value) && value.every(isOtlpAttribute);
}

function isPromptProvenance(value: unknown): value is PromptProvenance {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		PROMPT_ID_PATTERN.test(value.id) &&
		typeof value.version === "number" &&
		Number.isSafeInteger(value.version) &&
		value.version > 0 &&
		typeof value.content_hash === "string" &&
		CONTENT_HASH_PATTERN.test(value.content_hash)
	);
}

function isMetadataEnvelope(value: unknown): value is ObservationMetadata {
	return (
		isRecord(value) &&
		value.schema_version === 1 &&
		isAttributeArray(value.attributes) &&
		(value.truncated === undefined || value.truncated === true) &&
		(value.prompt_provenance === undefined ||
			value.prompt_provenance === null ||
			isPromptProvenance(value.prompt_provenance))
	);
}

function sanitizeMetadataAttributes(
	attributes: OtlpAttribute[],
): OtlpAttribute[] {
	return attributes.filter(
		(attribute) => !attribute.key.startsWith("glasshouse.prompt."),
	);
}

/** Canonical observation row from REST and SSE endpoints. */
export interface ObservationRow {
	observation_id: string;
	trace_id: string;
	project_id: string;
	parent_observation_id: string | null;
	type: "span" | "event" | "generation" | "tool";
	name: string;
	start_time: string;
	end_time: string | null;
	duration_ms: number | null;
	status: "ok" | "error";
	model: string | null;
	input_text: string;
	output_text: string;
	metadata: ObservationMetadata;
	input_retained_truncated?: boolean;
	output_retained_truncated?: boolean;
	input_excerpt_truncated?: boolean;
	output_excerpt_truncated?: boolean;
	metadata_truncated?: boolean;
}

export interface TraceListResponse {
	items: TraceRow[];
	total: number;
	response_truncated?: boolean;
	next_cursor?: string;
}

function buildQs(
	params: Record<string, string | number | undefined | null>,
): string {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined || v === null) continue;
		sp.set(k, String(v));
	}
	const s = sp.toString();
	return s ? `?${s}` : "";
}

export interface ListTracesParams {
	project_id: string;
	limit?: number;
	offset?: number;
	cursor?: string;
	env?: string;
	agent_id?: string;
	name?: string;
	status?: string;
	duration?: string;
	scores?: string;
	input_text?: string;
	time_from?: string;
	time_to?: string;
}

export async function listTraces(
	params: ListTracesParams,
): Promise<TraceListResponse> {
	const qs = buildQs({
		project_id: params.project_id,
		limit: params.limit,
		offset: params.offset,
		cursor: params.cursor,
		"filter[env]": params.env,
		"filter[agent_id]": params.agent_id,
		"filter[name]": params.name,
		"filter[status]": params.status,
		"filter[duration]": params.duration,
		"filter[scores]": params.scores,
		"filter[input_text]": params.input_text,
		"filter[time.from]": params.time_from,
		"filter[time.to]": params.time_to,
	});
	return responseJson(await authedFetch(`/v1/traces${qs}`), "listTraces");
}

export interface ListObservationsParams {
	project_id: string;
	limit?: number;
	offset?: number;
	cursor?: string;
	agent_id?: string;
	trace_id?: string;
	type?: string;
	name?: string;
	status?: string;
	duration?: string;
	model?: string;
	input_text?: string;
	time_from?: string;
	time_to?: string;
}

export interface ObservationListResponse {
	items: ObservationRow[];
	total: number;
	response_truncated?: boolean;
	next_cursor?: string;
}

export interface TraceDetailResponse {
	trace: TraceRow;
	observations: ObservationRow[];
	response_truncated?: boolean;
	next_cursor?: string;
}

export async function getTraceDetail(
	traceId: string,
	params: { project_id: string; cursor?: string },
): Promise<TraceDetailResponse> {
	const qs = buildQs({
		project_id: params.project_id,
		cursor: params.cursor,
	});
	const res = await authedFetch(
		`/v1/traces/${encodeURIComponent(traceId)}${qs}`,
	);
	if (!res.ok) throw new Error(`getTraceDetail ${res.status}`);
	const response = (await res.json()) as TraceDetailResponse;
	return {
		...response,
		observations: response.observations.map((observation) => ({
			...observation,
			metadata: normalizeObservationMetadata(
				observation.metadata,
				observation.type === "generation",
			),
		})),
	};
}

export async function listObservations(
	params: ListObservationsParams,
): Promise<ObservationListResponse> {
	const qs = buildQs({
		project_id: params.project_id,
		limit: params.limit,
		offset: params.offset,
		cursor: params.cursor,
		"filter[agent_id]": params.agent_id,
		"filter[trace_id]": params.trace_id,
		"filter[type]": params.type,
		"filter[name]": params.name,
		"filter[status]": params.status,
		"filter[duration]": params.duration,
		"filter[model]": params.model,
		"filter[input_text]": params.input_text,
		"filter[time.from]": params.time_from,
		"filter[time.to]": params.time_to,
	});
	const res = await authedFetch(`/v1/observations${qs}`);
	if (!res.ok) throw new Error(`listObservations ${res.status}`);
	const response = (await res.json()) as ObservationListResponse;
	return {
		...response,
		items: response.items.map((observation) => ({
			...observation,
			metadata: normalizeObservationMetadata(
				observation.metadata,
				observation.type === "generation",
			),
		})),
	};
}

export async function seedRandomTrace(projectId: string): Promise<{
	traceId: string;
	spanCount: number;
}> {
	const traceId = crypto.randomUUID().replaceAll("-", "");
	const rootSpanId = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
	const spanCount = Math.floor(Math.random() * 10) + 1;
	const startNano = BigInt(Date.now()) * 1_000_000n;
	const endNano = startNano + BigInt(spanCount * 25 + 100) * 1_000_000n;

	const childSpans = Array.from({ length: spanCount - 1 }, (_, index) => {
		const childStart = startNano + BigInt((index + 1) * 25) * 1_000_000n;
		return {
			trace_id: traceId,
			span_id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
			parent_span_id: rootSpanId,
			name: `debug-span-${index + 1}`,
			kind: 1,
			start_time_unix_nano: childStart.toString(),
			end_time_unix_nano: (childStart + 15_000_000n).toString(),
			attributes: [
				{
					key: "deployment.environment",
					value: { stringValue: "development" },
				},
			],
			status: { code: 1 },
		};
	});

	const rootSpan = {
		trace_id: traceId,
		span_id: rootSpanId,
		name: `debug-trace-${traceId.slice(0, 8)}`,
		kind: 1,
		start_time_unix_nano: startNano.toString(),
		end_time_unix_nano: endNano.toString(),
		attributes: [
			{ key: "deployment.environment", value: { stringValue: "development" } },
		],
		status: { code: 1 },
	};
	const spans = [...childSpans, rootSpan];

	const res = await authedFetch("/v1/otel/v1/traces", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-glasshouse-project-id": projectId,
		},
		body: JSON.stringify({
			resource_spans: [
				{
					resource: { attributes: [] },
					scope_spans: [{ scope: { name: "glasshouse.sse-debug" }, spans }],
				},
			],
		}),
	});
	if (!res.ok) throw new Error(`seedRandomTrace ${res.status}`);

	return { traceId, spanCount };
}

export interface OtlpCredential {
	id: string;
	project_id: string;
	name: string;
	secret_prefix: string;
	created_by_actor_id: string;
	created_at: string;
	rotated_at: string | null;
	revoked_at: string | null;
	last_used_at: string | null;
}

export interface OtlpCredentialWithSecret {
	credential: OtlpCredential;
	secret: string;
}

export async function listOtlpCredentials(
	projectId: string,
): Promise<{ items: OtlpCredential[] }> {
	const query = new URLSearchParams({ project_id: projectId });
	return responseJson(
		await authedFetch(`/v1/admin/otlp-credentials?${query}`),
		"List OTLP credentials",
	);
}

export async function createOtlpCredential(input: {
	project_id: string;
	name: string;
}): Promise<OtlpCredentialWithSecret> {
	return responseJson(
		await authedFetch("/v1/admin/otlp-credentials", jsonRequest(input)),
		"Create OTLP credential",
	);
}

export async function rotateOtlpCredential(input: {
	project_id: string;
	id: string;
}): Promise<OtlpCredentialWithSecret> {
	const query = new URLSearchParams({ project_id: input.project_id });
	return responseJson(
		await authedFetch(
			`/v1/admin/otlp-credentials/${encodeURIComponent(input.id)}/rotate?${query}`,
			{ method: "POST" },
		),
		"Rotate OTLP credential",
	);
}

export async function revokeOtlpCredential(input: {
	project_id: string;
	id: string;
}): Promise<OtlpCredential> {
	const query = new URLSearchParams({ project_id: input.project_id });
	return responseJson(
		await authedFetch(
			`/v1/admin/otlp-credentials/${encodeURIComponent(input.id)}/revoke?${query}`,
			{ method: "POST" },
		),
		"Revoke OTLP credential",
	);
}
