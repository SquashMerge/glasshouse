import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	PromptTemplateError,
	renderPromptTemplateWithWarnings,
	validatePromptTemplate,
} from "../lib/prompt-templates.js";
import {
	MAX_DIFF_INPUT_CHARS,
	MAX_DIFF_INPUT_LINES,
	hasAtMostLines,
} from "../lib/prompt-limits.js";

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type PromptRole = "system" | "user";
export type PromptMessage = { role: PromptRole; content: string };

export type PromptVersion = {
	id: string;
	version: number;
	messages: PromptMessage[];
	model: string | null;
	settings: JsonObject;
	change_summary: string;
	created_by: string;
	created_at: string;
	content_hash: string;
	diff: string | null;
};

export type Prompt = PromptVersion & {
	project_id: string;
	name: string;
	description: string | null;
};

export type Project = {
	id: string;
	name: string;
	slug: string;
	created_at: string;
};

export type PromptRepositoryErrorCode =
	| "BAD_REQUEST"
	| "NOT_FOUND"
	| "CONFLICT"
	| "INTERNAL";

export class PromptRepositoryError extends Error {
	readonly status: 400 | 404 | 409 | 500;

	constructor(
		readonly code: PromptRepositoryErrorCode,
		message: string,
		override readonly cause?: unknown,
	) {
		super(message);
		this.name = "PromptRepositoryError";
		this.status =
			code === "BAD_REQUEST"
				? 400
				: code === "NOT_FOUND"
					? 404
					: code === "CONFLICT"
						? 409
						: 500;
	}
}

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type Row = Record<string, unknown>;

function error(
	code: PromptRepositoryErrorCode,
	message: string,
	cause?: unknown,
): PromptRepositoryError {
	return new PromptRepositoryError(code, message, cause);
}

function databaseCode(value: unknown): string | undefined {
	return typeof value === "object" &&
		value !== null &&
		"code" in value &&
		typeof value.code === "string"
		? value.code
		: undefined;
}

function normalizeError(value: unknown): PromptRepositoryError {
	if (value instanceof PromptRepositoryError) return value;
	if (value instanceof PromptTemplateError)
		return error("BAD_REQUEST", value.message, value);
	if (databaseCode(value) === "23505")
		return error(
			"CONFLICT",
			"Prompt already exists or has been deleted",
			value,
		);
	return error("INTERNAL", "Prompt repository operation failed", value);
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(row: Row, key: string): string {
	const value = row[key];
	if (typeof value !== "string")
		throw error("INTERNAL", `Persisted prompt ${key} is invalid`);
	return value;
}

function nullableStringValue(row: Row, key: string): string | null {
	const value = row[key];
	if (value === null || typeof value === "undefined") return null;
	if (typeof value !== "string")
		throw error("INTERNAL", `Persisted prompt ${key} is invalid`);
	return value;
}

function positiveInteger(value: unknown, key: string): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 1)
		throw error("INTERNAL", `Persisted prompt ${key} is invalid`);
	return parsed;
}

function timestampValue(row: Row, key: string): string {
	const value = row[key];
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") return value;
	throw error("INTERNAL", `Persisted prompt ${key} is invalid`);
}

function jsonObjectValue(row: Row, key: string): JsonObject {
	const raw = row[key];
	let value = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw) as unknown;
		} catch (cause) {
			throw error("INTERNAL", `Persisted prompt ${key} is invalid JSON`, cause);
		}
	}
	if (!isObject(value))
		throw error("INTERNAL", `Persisted prompt ${key} is invalid`);
	return value;
}

function promptMessages(row: Row, key: string): PromptMessage[] {
	const raw = row[key];
	let value = raw;
	if (typeof raw === "string") {
		try {
			value = JSON.parse(raw) as unknown;
		} catch (cause) {
			throw error("INTERNAL", `Persisted prompt ${key} is invalid JSON`, cause);
		}
	}
	if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
		throw error("INTERNAL", `Persisted prompt ${key} is invalid`);
	}
	const messages = value.map((message) => {
		if (
			!isObject(message) ||
			typeof message.content !== "string" ||
			(message.role !== "system" && message.role !== "user")
		) {
			throw error("INTERNAL", `Persisted prompt ${key} is invalid`);
		}
		return { role: message.role as PromptRole, content: message.content };
	});
	if (
		new Set(messages.map((message) => message.role)).size !== messages.length
	) {
		throw error("INTERNAL", `Persisted prompt ${key} is invalid`);
	}
	return messages;
}

function query<RowType extends Row>(
	client: Queryable,
	text: string,
	values: unknown[] = [],
): Promise<RowType[]> {
	return client.query(text, values).then((result) => result.rows as RowType[]);
}

async function requireProject(
	client: Queryable,
	projectId: string,
	lock = false,
): Promise<void> {
	const rows = await query(
		client,
		`SELECT id FROM projects WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
		[projectId],
	);
	if (rows.length === 0) throw error("NOT_FOUND", "Project not found");
}

async function transaction<T>(
	pool: Pick<Pool, "connect">,
	operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
	let client: PoolClient | undefined;
	let primaryError: unknown;
	try {
		client = await pool.connect();
		await client.query("BEGIN");
		try {
			const result = await operation(client);
			await client.query("COMMIT");
			return result;
		} catch (cause) {
			primaryError = cause;
			try {
				await client.query("ROLLBACK");
			} catch (rollbackCause) {
				throw error(
					"INTERNAL",
					"Prompt transaction rollback failed",
					new AggregateError([cause, rollbackCause]),
				);
			}
			throw cause;
		}
	} catch (cause) {
		throw normalizeError(cause);
	} finally {
		if (client) {
			try {
				client.release();
			} catch (releaseCause) {
				if (primaryError) {
					throw error(
						"INTERNAL",
						"Prompt transaction failed and client release failed",
						new AggregateError([primaryError, releaseCause]),
					);
				}
				throw error(
					"INTERNAL",
					"Prompt transaction client release failed",
					releaseCause,
				);
			}
		}
	}
}

async function read<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (cause) {
		throw normalizeError(cause);
	}
}

function normalizedName(value: unknown): string {
	if (typeof value !== "string" || value.length === 0)
		throw error("BAD_REQUEST", "name must be a non-empty string");
	return value;
}

function normalizedActor(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw error("INTERNAL", "Trusted actor is unavailable");
	return value;
}

function normalizedSummary(value: unknown, fallback?: string): string {
	if (typeof value === "undefined" && fallback) return fallback;
	if (typeof value !== "string" || value.trim().length === 0)
		throw error("BAD_REQUEST", "change_summary must not be blank");
	return value.trim();
}

function serializedSettings(value: unknown): string {
	if (!isObject(value))
		throw error("BAD_REQUEST", "settings must be a JSON object");
	try {
		const serialized = JSON.stringify(value);
		if (!serialized || !isObject(JSON.parse(serialized) as unknown)) {
			throw error("BAD_REQUEST", "settings must be a JSON object");
		}
		return serialized;
	} catch (cause) {
		if (cause instanceof PromptRepositoryError) throw cause;
		throw error("BAD_REQUEST", "settings must be JSON serializable", cause);
	}
}

function modelValue(value: unknown): string | null {
	if (value === null || typeof value === "undefined") return null;
	if (typeof value !== "string")
		throw error("BAD_REQUEST", "model must be a string or null");
	return value;
}

function sourceValue(value: unknown): string {
	if (typeof value !== "string")
		throw error("BAD_REQUEST", "source must be a string");
	try {
		validatePromptTemplate(value);
	} catch (cause) {
		throw normalizeError(cause);
	}
	return value;
}

function messagesValue(value: unknown): PromptMessage[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
		throw error(
			"BAD_REQUEST",
			"messages must contain one or two prompt messages",
		);
	}
	const messages = value.map((message) => {
		if (
			!isObject(message) ||
			(message.role !== "system" && message.role !== "user")
		) {
			throw error(
				"BAD_REQUEST",
				"Each prompt message must have a system or user role",
			);
		}
		return {
			role: message.role as PromptRole,
			content: sourceValue(message.content),
		};
	});
	if (
		new Set(messages.map((message) => message.role)).size !== messages.length
	) {
		throw error(
			"BAD_REQUEST",
			"Each prompt may contain at most one system and one user message",
		);
	}
	return messages;
}

export function normalizePromptSlug(name: string): string {
	const normalized = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return (normalized || "prompt").slice(0, 64).replace(/-+$/g, "") || "prompt";
}

function collisionSlug(base: string, collision: number): string {
	const extension = `-${collision}`;
	return `${base.slice(0, 64 - extension.length).replace(/-+$/g, "")}${extension}`;
}

async function advisoryLock(
	client: PoolClient,
	projectId: string,
	slug: string,
): Promise<void> {
	await query(client, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
		`prompt:${projectId}:${slug}`,
	]);
}

function mapVersion(row: Row): PromptVersion {
	const previousMessages =
		row.previous_messages === null ||
		typeof row.previous_messages === "undefined"
			? null
			: promptMessages(row, "previous_messages");
	const messages = promptMessages(row, "messages");
	return {
		id: stringValue(row, "slug"),
		version: positiveInteger(row.version, "version"),
		messages,
		model: nullableStringValue(row, "model"),
		settings: jsonObjectValue(row, "settings"),
		change_summary: stringValue(row, "change_summary"),
		created_by: stringValue(row, "created_by"),
		created_at: timestampValue(row, "created_at"),
		content_hash: stringValue(row, "content_hash"),
		diff:
			previousMessages === null
				? null
				: boundedTextualVersionDiff(
						messagesText(previousMessages),
						messagesText(messages),
					),
	};
}

function mapPrompt(row: Row): Prompt {
	return {
		...mapVersion(row),
		project_id: stringValue(row, "project_id"),
		name: stringValue(row, "name"),
		description: nullableStringValue(row, "description"),
	};
}

const versionColumns = `
  p.slug,
  v.version,
  v.messages,
  v.model,
  v.settings,
  v.change_message AS change_summary,
  v.created_by,
  v.created_at,
  v.content_hash,
  previous_version.messages AS previous_messages`;

const previousVersionJoin = `
  LEFT JOIN prompt_versions AS previous_version
    ON previous_version.prompt_id = v.prompt_id
    AND previous_version.version = v.version - 1`;

export function textualVersionDiff(previous: string, current: string): string {
	assertDiffBudget(previous, "previous");
	assertDiffBudget(current, "current");
	if (previous === current) return "";
	const before = previous.split("\n");
	const after = current.split("\n");
	const matrix = Array.from({ length: before.length + 1 }, () =>
		Array<number>(after.length + 1).fill(0),
	);
	for (let left = before.length - 1; left >= 0; left -= 1) {
		for (let right = after.length - 1; right >= 0; right -= 1) {
			matrix[left]![right] =
				before[left] === after[right]
					? matrix[left + 1]![right + 1]! + 1
					: Math.max(matrix[left + 1]![right]!, matrix[left]![right + 1]!);
		}
	}
	const lines = ["--- previous", "+++ current"];
	let left = 0;
	let right = 0;
	while (left < before.length || right < after.length) {
		if (
			left < before.length &&
			right < after.length &&
			before[left] === after[right]
		) {
			lines.push(` ${before[left]}`);
			left += 1;
			right += 1;
		} else if (
			right < after.length &&
			(left === before.length ||
				matrix[left]![right + 1]! >= matrix[left + 1]![right]!)
		) {
			lines.push(`+${after[right]}`);
			right += 1;
		} else {
			lines.push(`-${before[left]}`);
			left += 1;
		}
	}
	return lines.join("\n");
}

function assertDiffBudget(value: string, name: string): void {
	if (value.length > MAX_DIFF_INPUT_CHARS) {
		throw error(
			"BAD_REQUEST",
			`Prompt diff ${name} source exceeds ${MAX_DIFF_INPUT_CHARS} characters`,
		);
	}
	if (!hasAtMostLines(value, MAX_DIFF_INPUT_LINES)) {
		throw error(
			"BAD_REQUEST",
			`Prompt diff ${name} source exceeds ${MAX_DIFF_INPUT_LINES} lines`,
		);
	}
}

function boundedTextualVersionDiff(
	previous: string,
	current: string,
): string | null {
	try {
		return textualVersionDiff(previous, current);
	} catch (cause) {
		if (cause instanceof PromptRepositoryError && cause.code === "BAD_REQUEST")
			return null;
		throw cause;
	}
}

function messagesText(messages: readonly PromptMessage[]): string {
	return messages
		.map((message) => `${message.role}:\n${message.content}`)
		.join("\n\n");
}

export async function listProjects(
	pool: Pick<Pool, "query">,
): Promise<{ items: Project[]; total: number }> {
	return read(async () => {
		const countRows = await query<Row>(
			pool,
			"SELECT count(*) AS total FROM projects",
		);
		const rows = await query<Row>(
			pool,
			"SELECT id, name, slug, created_at FROM projects ORDER BY slug ASC",
		);
		const total = positiveIntegerOrZero(countRows[0]?.total, "total");
		return {
			items: rows.map((row) => ({
				id: stringValue(row, "id"),
				name: stringValue(row, "name"),
				slug: stringValue(row, "slug"),
				created_at: timestampValue(row, "created_at"),
			})),
			total,
		};
	});
}

function positiveIntegerOrZero(value: unknown, key: string): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN;
	if (!Number.isSafeInteger(parsed) || parsed < 0)
		throw error("INTERNAL", `Persisted prompt ${key} is invalid`);
	return parsed;
}

export async function listPrompts(
	pool: Pick<Pool, "query">,
	projectId: string,
): Promise<{ items: Prompt[]; total: number }> {
	return read(async () => {
		await requireProject(pool, projectId);
		const countRows = await query<Row>(
			pool,
			"SELECT count(*) AS total FROM prompts WHERE project_id = $1",
			[projectId],
		);
		const rows = await query<Row>(
			pool,
			`SELECT p.project_id, p.name, p.description, ${versionColumns}
       FROM prompts AS p
       INNER JOIN LATERAL (
         SELECT * FROM prompt_versions WHERE prompt_id = p.id ORDER BY version DESC LIMIT 1
       ) AS v ON TRUE
       ${previousVersionJoin}
       WHERE p.project_id = $1
       ORDER BY p.slug ASC`,
			[projectId],
		);
		return {
			items: rows.map(mapPrompt),
			total: positiveIntegerOrZero(countRows[0]?.total, "total"),
		};
	});
}

export type CreatePromptInput = {
	project_id: string;
	name: string;
	description?: string | null;
	messages: PromptMessage[];
	model?: string | null;
	settings?: JsonObject;
	change_summary?: string;
	actor: string;
};

async function selectAvailableSlug(
	client: PoolClient,
	projectId: string,
	baseSlug: string,
): Promise<string> {
	const baseTombstone = await query<Row>(
		client,
		"SELECT slug FROM prompt_tombstones WHERE project_id = $1 AND slug = $2",
		[projectId, baseSlug],
	);
	if (baseTombstone.length > 0)
		throw error("CONFLICT", "Prompt identifier has been deleted");

	const basePrompt = await query<Row>(
		client,
		"SELECT slug FROM prompts WHERE project_id = $1 AND slug = $2",
		[projectId, baseSlug],
	);
	if (basePrompt.length === 0) return baseSlug;

	for (let collision = 2; collision < 10_000; collision += 1) {
		const candidate = collisionSlug(baseSlug, collision);
		const active = await query<Row>(
			client,
			"SELECT slug FROM prompts WHERE project_id = $1 AND slug = $2",
			[projectId, candidate],
		);
		const tombstone = await query<Row>(
			client,
			"SELECT slug FROM prompt_tombstones WHERE project_id = $1 AND slug = $2",
			[projectId, candidate],
		);
		if (active.length === 0 && tombstone.length === 0) return candidate;
	}
	throw error("CONFLICT", "Could not allocate a prompt identifier");
}

async function insertVersion(
	client: PoolClient,
	input: {
		promptId: string;
		slug: string;
		version: number;
		messages: PromptMessage[];
		model: string | null;
		settings: string;
		changeSummary: string;
		actor: string;
	},
): Promise<PromptVersion> {
	const messages = JSON.stringify(input.messages);
	const content =
		input.messages.find((message) => message.role === "user")?.content ??
		input.messages[0]!.content;
	const rows = await query<Row>(
		client,
		`INSERT INTO prompt_versions (
       prompt_id, version, content, model, metadata, messages, settings, change_message, created_by
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $5::jsonb, $7, $8)
     RETURNING
       $9::text AS slug,
       version,
       messages,
       model,
       settings,
       change_message AS change_summary,
       created_by,
       created_at,
       content_hash,
       NULL::jsonb AS previous_messages`,
		[
			input.promptId,
			input.version,
			content,
			input.model,
			input.settings,
			messages,
			input.changeSummary,
			input.actor,
			input.slug,
		],
	);
	const row = rows[0];
	if (!row) throw error("INTERNAL", "Prompt version insert returned no row");
	return mapVersion(row);
}

export async function createPrompt(
	pool: Pick<Pool, "connect">,
	input: CreatePromptInput,
): Promise<Prompt> {
	const name = normalizedName(input.name);
	const messages = messagesValue(input.messages);
	const description =
		input.description === undefined ? null : input.description;
	if (description !== null && typeof description !== "string")
		throw error("BAD_REQUEST", "description must be a string or null");
	const model = modelValue(input.model);
	const settings = serializedSettings(input.settings ?? {});
	const changeSummary = normalizedSummary(
		input.change_summary,
		"Initial version",
	);
	const actor = normalizedActor(input.actor);
	const baseSlug = normalizePromptSlug(name);
	const promptId = randomUUID();

	return transaction(pool, async (client) => {
		await requireProject(client, input.project_id, true);
		await advisoryLock(client, input.project_id, baseSlug);
		const slug = await selectAvailableSlug(client, input.project_id, baseSlug);
		const promptRows = await query<Row>(
			client,
			`INSERT INTO prompts (id, project_id, name, slug, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING project_id, name, slug, description`,
			[promptId, input.project_id, name, slug, description],
		);
		const promptRow = promptRows[0];
		if (!promptRow) throw error("INTERNAL", "Prompt insert returned no row");
		const version = await insertVersion(client, {
			promptId,
			slug,
			version: 1,
			messages,
			model,
			settings,
			changeSummary,
			actor,
		});
		return {
			...version,
			project_id: stringValue(promptRow, "project_id"),
			name: stringValue(promptRow, "name"),
			description: nullableStringValue(promptRow, "description"),
		};
	});
}

export async function getPrompt(
	pool: Pick<Pool, "query">,
	input: { project_id: string; slug: string; version?: number },
): Promise<Prompt> {
	return read(async () => {
		await requireProject(pool, input.project_id);
		const predicate = input.version === undefined ? "" : "AND v.version = $3";
		const values =
			input.version === undefined
				? [input.project_id, input.slug]
				: [input.project_id, input.slug, input.version];
		const rows = await query<Row>(
			pool,
			`SELECT p.project_id, p.name, p.description, ${versionColumns}
       FROM prompts AS p
       INNER JOIN prompt_versions AS v ON v.prompt_id = p.id
       ${previousVersionJoin}
       WHERE p.project_id = $1 AND p.slug = $2 ${predicate}
       ORDER BY v.version DESC
       LIMIT 1`,
			values,
		);
		const row = rows[0];
		if (!row) throw error("NOT_FOUND", "Prompt or version not found");
		return mapPrompt(row);
	});
}

export async function listPromptVersions(
	pool: Pick<Pool, "query">,
	input: { project_id: string; slug: string },
): Promise<{ items: PromptVersion[] }> {
	return read(async () => {
		await requireProject(pool, input.project_id);
		const rows = await query<Row>(
			pool,
			`SELECT ${versionColumns}
       FROM prompts AS p
       INNER JOIN prompt_versions AS v ON v.prompt_id = p.id
       ${previousVersionJoin}
       WHERE p.project_id = $1 AND p.slug = $2
       ORDER BY v.version DESC`,
			[input.project_id, input.slug],
		);
		if (rows.length === 0) throw error("NOT_FOUND", "Prompt not found");
		return { items: rows.map(mapVersion) };
	});
}

export type CreatePromptVersionInput = {
	project_id: string;
	slug: string;
	base_version: number;
	messages: PromptMessage[];
	model?: string | null;
	settings?: JsonObject;
	change_summary: string;
	actor: string;
};

export async function createPromptVersion(
	pool: Pick<Pool, "connect">,
	input: CreatePromptVersionInput,
): Promise<PromptVersion> {
	const messages = messagesValue(input.messages);
	const changeSummary = normalizedSummary(input.change_summary);
	const actor = normalizedActor(input.actor);
	if (!Number.isSafeInteger(input.base_version) || input.base_version < 1)
		throw error("BAD_REQUEST", "base_version must be a positive integer");
	const providedSettings = Object.prototype.hasOwnProperty.call(
		input,
		"settings",
	)
		? serializedSettings(input.settings)
		: undefined;

	return transaction(pool, async (client) => {
		await requireProject(client, input.project_id, true);
		const promptRows = await query<Row>(
			client,
			`SELECT id, slug FROM prompts
       WHERE project_id = $1 AND slug = $2
       FOR UPDATE`,
			[input.project_id, input.slug],
		);
		const prompt = promptRows[0];
		if (!prompt) throw error("NOT_FOUND", "Prompt not found");
		const activeOptimization = await query<Row>(
			client,
			`SELECT id FROM prompt_optimization_jobs
        WHERE prompt_id = $1
          AND status IN ('queued', 'preparing', 'optimizing', 'evaluating')
        LIMIT 1`,
			[stringValue(prompt, "id")],
		);
		if (activeOptimization.length > 0)
			throw error(
				"CONFLICT",
				"Stop the active optimization before creating a version",
			);
		const latestRows = await query<Row>(
			client,
			`SELECT version, model, settings
       FROM prompt_versions
       WHERE prompt_id = $1
       ORDER BY version DESC
       LIMIT 1`,
			[stringValue(prompt, "id")],
		);
		const latest = latestRows[0];
		if (!latest) throw error("INTERNAL", "Prompt has no versions");
		const latestVersion = positiveInteger(latest.version, "version");
		if (latestVersion !== input.base_version)
			throw error("CONFLICT", "Prompt base version is stale");
		const model = Object.prototype.hasOwnProperty.call(input, "model")
			? modelValue(input.model)
			: nullableStringValue(latest, "model");
		const settings =
			providedSettings ??
			serializedSettings(jsonObjectValue(latest, "settings"));
		return insertVersion(client, {
			promptId: stringValue(prompt, "id"),
			slug: stringValue(prompt, "slug"),
			version: latestVersion + 1,
			messages,
			model,
			settings,
			changeSummary,
			actor,
		});
	});
}

export async function renderPrompt(
	pool: Pick<Pool, "query">,
	input: {
		project_id: string;
		slug: string;
		version?: number;
		data: JsonObject;
	},
): Promise<{
	id: string;
	version: number;
	content_hash: string;
	messages: PromptMessage[];
	warnings: { code: "MISSING_VARIABLE"; role: PromptRole; path: string }[];
}> {
	return read(async () => {
		const prompt = await getPrompt(pool, {
			project_id: input.project_id,
			slug: input.slug,
			version: input.version,
		});
		const messages = prompt.messages.map((message) => {
			const rendered = renderPromptTemplateWithWarnings(
				message.content,
				input.data,
			);
			return {
				message: { role: message.role, content: rendered.output },
				warnings: rendered.warnings,
			};
		});
		return {
			id: prompt.id,
			version: prompt.version,
			content_hash: prompt.content_hash,
			messages: messages.map(({ message }) => message),
			warnings: messages.flatMap(({ message, warnings }) =>
				warnings.map((warning) => ({ ...warning, role: message.role })),
			),
		};
	});
}

export async function deletePrompt(
	pool: Pick<Pool, "connect">,
	input: {
		project_id: string;
		slug: string;
		confirmation: string;
		actor: string;
	},
): Promise<void> {
	if (input.confirmation !== input.slug)
		throw error("BAD_REQUEST", "confirmation must equal the prompt identifier");
	const actor = normalizedActor(input.actor);
	return transaction(pool, async (client) => {
		await requireProject(client, input.project_id, true);
		await advisoryLock(client, input.project_id, input.slug);
		const tombstoneRows = await query<Row>(
			client,
			"SELECT slug FROM prompt_tombstones WHERE project_id = $1 AND slug = $2",
			[input.project_id, input.slug],
		);
		if (tombstoneRows.length > 0)
			throw error("CONFLICT", "Prompt identifier has been deleted");
		const promptRows = await query<Row>(
			client,
			`SELECT id, slug FROM prompts
       WHERE project_id = $1 AND slug = $2
       FOR UPDATE`,
			[input.project_id, input.slug],
		);
		const prompt = promptRows[0];
		if (!prompt) throw error("NOT_FOUND", "Prompt not found");
		const promptId = stringValue(prompt, "id");
		const countRows = await query<Row>(
			client,
			"SELECT count(*) AS total FROM prompt_versions WHERE prompt_id = $1",
			[promptId],
		);
		const deletedVersionCount = positiveIntegerOrZero(
			countRows[0]?.total,
			"deleted_version_count",
		);
		await query(
			client,
			"DELETE FROM prompt_labels WHERE project_id = $1 AND prompt_id = $2",
			[input.project_id, promptId],
		);
		await query(
			client,
			`DELETE FROM prompt_label_quarantine
        WHERE original_prompt_id = $1
          AND original_project_id = $2
          AND EXISTS (SELECT 1 FROM prompts WHERE id = $1 AND project_id = $2)`,
			[promptId, input.project_id],
		);
		await query(
			client,
			`INSERT INTO prompt_deletion_audit (project_id, prompt_id, slug, deleted_by, deleted_version_count)
       VALUES ($1, $2, $3, $4, $5)`,
			[input.project_id, promptId, input.slug, actor, deletedVersionCount],
		);
		await query(
			client,
			"INSERT INTO prompt_tombstones (project_id, slug) VALUES ($1, $2)",
			[input.project_id, input.slug],
		);
		await query(
			client,
			"DELETE FROM prompts WHERE id = $1 AND project_id = $2 AND slug = $3",
			[promptId, input.project_id, input.slug],
		);
	});
}

export async function promptProvenanceStatus(
	pool: Pick<Pool, "query">,
	input: {
		project_id: string;
		slug: string;
		version: number;
		content_hash: string;
	},
): Promise<"active" | "deleted" | "unknown"> {
	return read(async () => {
		await requireProject(pool, input.project_id);
		const rows = await query<Row>(
			pool,
			`SELECT CASE
         WHEN EXISTS (
           SELECT 1
           FROM prompt_tombstones AS t
           WHERE t.project_id = $1 AND t.slug = $2
         ) THEN 'deleted'
         WHEN EXISTS (
           SELECT 1
           FROM prompts AS p
           INNER JOIN prompt_versions AS v ON v.prompt_id = p.id
           WHERE p.project_id = $1 AND p.slug = $2 AND v.version = $3 AND v.content_hash = $4
         ) THEN 'active'
         ELSE 'unknown'
       END AS status`,
			[input.project_id, input.slug, input.version, input.content_hash],
		);
		const status = rows[0]?.status;
		if (status === "active" || status === "deleted" || status === "unknown")
			return status;
		throw error("INTERNAL", "Prompt provenance status is invalid");
	});
}
