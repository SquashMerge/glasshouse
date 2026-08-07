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

	it("records safe error metadata without raw message, stack header, or causes", () => {
		process.env.LOG_LEVEL = "debug";
		const records: Array<Record<string, unknown>> = [];
		console.error = (line: string) => records.push(JSON.parse(line));
		const secret = "api_key=private-key prompt: customer instruction";
		const cause = Object.assign(new Error(secret), {
			code: "INTERNAL",
		});
		const error = new TypeError(secret, { cause });

		logger.error("optimization.start_failed", error, {
			project_id: "project-1",
		});

		expect(records).toEqual([
			expect.objectContaining({
				level: "error",
				event: "optimization.start_failed",
				project_id: "project-1",
				error_type: "TypeError",
				error_stack_frames: expect.any(Number),
				error_cause: expect.objectContaining({
					error_type: "Error",
					error_code: "INTERNAL",
				}),
			}),
		]);
		const record = JSON.stringify(records[0]);
		expect(record).not.toContain(secret);
		expect(record).not.toContain("TypeError:");
		expect(records[0]?.error).toBeUndefined();
	});

	it("bounds circular and deep cause chains to type-only metadata", () => {
		process.env.LOG_LEVEL = "debug";
		const records: Array<Record<string, unknown>> = [];
		console.error = (line: string) => records.push(JSON.parse(line));
		const circular = new Error("credential=do-not-log");
		Object.assign(circular, { cause: circular });
		const deep = Array.from({ length: 8 }).reduce<Error>(
			(cause, _value, index) => new Error(`prompt-${index}`, { cause }),
			new Error("root-secret"),
		);

		logger.error("circular", circular);
		logger.error("deep", deep);

		expect(records[0]).toMatchObject({
			error_type: "Error",
			error_cause: { error_type: "Error", error_cause: "[circular]" },
		});
		let nested = records[1]?.error_cause as Record<string, unknown>;
		for (let index = 0; index < 5; index += 1)
			nested = nested.error_cause as Record<string, unknown>;
		expect(nested).toBe("[depth exceeded]");
		expect(JSON.stringify(records)).not.toContain("credential=do-not-log");
		expect(JSON.stringify(records)).not.toContain("root-secret");
	});

	it("does not leak hostile error metadata or throw while serializing it", () => {
		process.env.LOG_LEVEL = "debug";
		const records: Array<Record<string, unknown>> = [];
		console.error = (line: string) => records.push(JSON.parse(line));
		console.warn = (line: string) => records.push(JSON.parse(line));
		const secret = "provider-token-very-private";
		const error = new Error("hidden");
		Object.defineProperties(error, {
			name: { value: secret },
			code: { value: secret },
			stack: { value: `Error: hidden\n    at ${secret} (/srv/app.ts:1:1)` },
			cause: {
				get() {
					throw new Error(secret);
				},
			},
		});

		logger.error("hostile", error);
		const proxy = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error(secret);
				},
			},
		);
		expect(() => logger.warn("hostile-proxy", proxy, {})).not.toThrow();

		expect(records).toEqual([
			expect.objectContaining({ event: "hostile", error_type: "Error" }),
			expect.objectContaining({ event: "hostile-proxy", error_type: "object" }),
		]);
		expect(JSON.stringify(records)).not.toContain(secret);
	});

	it("records non-Error warning throws without spreading their raw value", () => {
		process.env.LOG_LEVEL = "debug";
		const records: Array<Record<string, unknown>> = [];
		console.warn = (line: string) => records.push(JSON.parse(line));

		logger.warn("otlp.body_parse_failed", "token=private-value");
		logger.warn("otlp.body_parse_failed", { credential: "private-object" }, {});

		expect(records).toEqual([
			expect.objectContaining({
				level: "warn",
				event: "otlp.body_parse_failed",
				error_type: "string",
			}),
			expect.objectContaining({
				level: "warn",
				event: "otlp.body_parse_failed",
				error_type: "object",
			}),
		]);
		expect(JSON.stringify(records)).not.toContain("private-value");
		expect(JSON.stringify(records)).not.toContain("private-object");
	});
});
