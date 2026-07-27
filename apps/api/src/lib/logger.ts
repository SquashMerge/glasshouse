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

function serializeError(error: unknown): LogFields {
	if (error instanceof Error) {
		return { error: error.message, error_type: error.name };
	}
	return { error: String(error) };
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
	warn(event: string, fields?: LogFields) {
		write("warn", event, fields);
	},
	error(event: string, error?: unknown, fields: LogFields = {}) {
		write("error", event, {
			...fields,
			...(error === undefined ? {} : serializeError(error)),
		});
	},
};
