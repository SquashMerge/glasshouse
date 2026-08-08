export type LogFields = Record<string, unknown>;
export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

function configuredLevel(): LogLevel {
	const value = process.env.LOG_LEVEL?.toLowerCase();
	return value === "debug" ||
		value === "info" ||
		value === "warn" ||
		value === "error"
		? value
		: "info";
}

const MAX_ERROR_STACK_SCAN_CHARS = 4_096;
const MAX_ERROR_STACK_FRAMES = 16;
const MAX_ERROR_CAUSE_DEPTH = 5;
const SAFE_ERROR_TYPES = new Set([
	"AggregateError",
	"BenchmarkRepositoryError",
	"DatasetRepositoryError",
	"Error",
	"EvalError",
	"ExperimentRepositoryError",
	"FeedbackRepositoryError",
	"GepaConfigurationError",
	"OtlpConflictError",
	"PromptRepositoryError",
	"PromptTemplateError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TenantScopeError",
	"TypeError",
	"URIError",
]);
const SAFE_ERROR_CODES = new Set([
	"BAD_REQUEST",
	"CONFLICT",
	"FORBIDDEN",
	"INTERNAL",
	"NOT_FOUND",
	"NOT_IMPLEMENTED",
	"PAYLOAD_TOO_LARGE",
	"UNAUTHORIZED",
]);

function isError(error: unknown): error is Error {
	try {
		return error instanceof Error;
	} catch {
		return false;
	}
}

function safelyRead<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		return undefined;
	}
}

function errorType(error: unknown): string {
	if (!isError(error)) return error === null ? "null" : typeof error;
	const name = safelyRead(() => error.name);
	return typeof name === "string" && SAFE_ERROR_TYPES.has(name)
		? name
		: "Error";
}

function safeErrorCode(error: Error): string | undefined {
	const code = safelyRead(() => (error as Error & { code?: unknown }).code);
	return typeof code === "string" && SAFE_ERROR_CODES.has(code)
		? code
		: undefined;
}

function stackFrameCount(error: Error): number | undefined {
	const stack = safelyRead(() => error.stack);
	if (typeof stack !== "string") return undefined;
	const count = stack
		.slice(0, MAX_ERROR_STACK_SCAN_CHARS)
		.split("\n")
		.slice(1)
		.filter((line) => /^\s*at\s+\S/u.test(line)).length;
	return count ? Math.min(count, MAX_ERROR_STACK_FRAMES) : undefined;
}

function serializeError(
	error: unknown,
	seen = new Set<unknown>(),
	depth = 0,
): LogFields {
	if (!isError(error)) return { error_type: errorType(error) };
	if (seen.has(error))
		return { error_type: errorType(error), error_cause: "[circular]" };
	seen.add(error);
	const cause = safelyRead(() => error.cause);
	const code = safeErrorCode(error);
	const frames = stackFrameCount(error);
	return {
		error_type: errorType(error),
		...(code ? { error_code: code } : {}),
		...(frames ? { error_stack_frames: frames } : {}),
		...(cause === undefined
			? {}
			: depth >= MAX_ERROR_CAUSE_DEPTH
				? { error_cause: "[depth exceeded]" }
				: { error_cause: serializeError(cause, seen, depth + 1) }),
	};
}

function write(level: LogLevel, event: string, fields: LogFields = {}): void {
	if (levelOrder[level] < levelOrder[configuredLevel()]) return;
	const record = {
		time: new Date().toISOString(),
		level,
		event,
		...fields,
	};
	const line = JSON.stringify(record);
	if (level === "error") console.error(line);
	else if (level === "warn") console.warn(line);
	else console.log(line);
}

export const logger = {
	debug(event: string, fields?: LogFields) {
		write("debug", event, fields);
	},
	info(event: string, fields?: LogFields) {
		write("info", event, fields);
	},
	warn(event: string, errorOrFields?: unknown, fields?: LogFields) {
		const isCaughtError =
			errorOrFields !== undefined &&
			(fields !== undefined ||
				isError(errorOrFields) ||
				errorOrFields === null ||
				typeof errorOrFields !== "object");
		write(
			"warn",
			event,
			isCaughtError
				? { ...fields, ...serializeError(errorOrFields) }
				: (errorOrFields as LogFields | undefined),
		);
	},
	error(event: string, error?: unknown, fields: LogFields = {}) {
		write("error", event, {
			...fields,
			...(error === undefined ? {} : serializeError(error)),
		});
	},
};
