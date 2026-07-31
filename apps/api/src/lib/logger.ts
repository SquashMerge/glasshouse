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

const MAX_ERROR_DETAIL_CHARS = 16_384;
const MAX_ERROR_CAUSE_DEPTH = 5;

function truncateErrorDetail(value: string): string {
	return value.length <= MAX_ERROR_DETAIL_CHARS
		? value
		: `${value.slice(0, MAX_ERROR_DETAIL_CHARS)}… [truncated]`;
}

function stringifyError(error: unknown): string {
	try {
		return truncateErrorDetail(String(error));
	} catch {
		return "[error could not be stringified]";
	}
}

function serializeError(
	error: unknown,
	seen = new Set<unknown>(),
	depth = 0,
): LogFields {
	if (!(error instanceof Error)) return { error: stringifyError(error) };
	if (seen.has(error)) return { error: "[circular error cause]" };
	seen.add(error);
	const cause = error.cause;
	return {
		error: truncateErrorDetail(error.message),
		error_type: error.name,
		...(error.stack ? { error_stack: truncateErrorDetail(error.stack) } : {}),
		...(cause === undefined
			? {}
			: depth >= MAX_ERROR_CAUSE_DEPTH
				? { error_cause: "[error cause depth exceeded]" }
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
	warn(event: string, errorOrFields?: unknown, fields: LogFields = {}) {
		write(
			"warn",
			event,
			errorOrFields instanceof Error
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
