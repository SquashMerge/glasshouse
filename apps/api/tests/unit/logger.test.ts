import { afterEach, describe, expect, it } from "bun:test";
import { logger } from "../../src/lib/logger";

describe("structured logger", () => {
	const originalLevel = process.env.LOG_LEVEL;
	const originalConsoleError = console.error;
	const originalConsoleWarn = console.warn;
	afterEach(() => {
		process.env.LOG_LEVEL = originalLevel;
		console.error = originalConsoleError;
		console.warn = originalConsoleWarn;
	});

	it("records an exception stack and its causal chain", () => {
		process.env.LOG_LEVEL = "debug";
		const records: Array<Record<string, unknown>> = [];
		console.error = (line: string) => records.push(JSON.parse(line));
		const databaseError = new Error("database connection lost");
		const optimizationError = new TypeError("optimization start failed", {
			cause: databaseError,
		});

		logger.error("optimization.start_failed", optimizationError, {
			project_id: "project-1",
		});

		expect(records).toEqual([
			expect.objectContaining({
				level: "error",
				event: "optimization.start_failed",
				project_id: "project-1",
				error: "optimization start failed",
				error_type: "TypeError",
				error_stack: expect.stringContaining("optimization start failed"),
				error_cause: expect.objectContaining({
					error: "database connection lost",
					error_type: "Error",
				}),
			}),
		]);
	});

	it("records caught exceptions emitted at warning level", () => {
		process.env.LOG_LEVEL = "debug";
		const records: Array<Record<string, unknown>> = [];
		console.warn = (line: string) => records.push(JSON.parse(line));

		logger.warn("otlp.body_parse_failed", new SyntaxError("invalid JSON"));

		expect(records).toEqual([
			expect.objectContaining({
				level: "warn",
				event: "otlp.body_parse_failed",
				error: "invalid JSON",
				error_type: "SyntaxError",
				error_stack: expect.stringContaining("invalid JSON"),
			}),
		]);
	});
});
