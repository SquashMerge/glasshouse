import { expect, test } from "bun:test";
import protobuf from "protobufjs";
import { logFilterNano } from "../../src/db/logs.js";
import {
	decodeLogExport,
	normalizeLogFields,
	redactLogValue,
} from "../../src/lib/otlp-logs.js";
import {
	ExportLogsRequest,
	type LogAnyValue,
	LogValue,
} from "../../src/schemas/logs.js";

const envelope = (
	body: unknown,
	timeUnixNano: unknown = "18446744073709551615",
) => ({
	resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano, body }] }] }],
});

test("binary log body selects the last oneof alternative in wire order", () => {
	for (const [first, last, expected] of [
		["string", "bool", { boolValue: false }],
		["bool", "string", { stringValue: "last" }],
	] as const) {
		const writer = protobuf.Writer.create();
		writer
			.uint32(10)
			.fork()
			.uint32(18)
			.fork()
			.uint32(18)
			.fork()
			.uint32(42)
			.fork();
		for (const field of [first, last]) {
			if (field === "string") writer.uint32(10).string("last");
			else writer.uint32(16).bool(false);
		}
		writer.ldelim().ldelim().ldelim().ldelim();
		const parsed = ExportLogsRequest.parse(
			normalizeLogFields(decodeLogExport(writer.finish()), "request", 0, true),
		);
		expect(parsed.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body).toEqual(
			expected,
		);
	}
});

test("wrong-wire known oneof fields are ignored like unknown protobuf fields", () => {
	const writer = protobuf.Writer.create();
	writer
		.uint32(10)
		.fork()
		.uint32(18)
		.fork()
		.uint32(18)
		.fork()
		.uint32(42)
		.fork();
	writer
		.uint32(10)
		.string("keep")
		.uint32(18)
		.bytes(Buffer.from([0]));
	writer.ldelim().ldelim().ldelim().ldelim();
	const parsed = ExportLogsRequest.parse(
		normalizeLogFields(decodeLogExport(writer.finish()), "request", 0, true),
	);
	expect(parsed.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body).toEqual({
		stringValue: "keep",
	});
});

test("quoted exponent log int64 values remain exact and bounded", () => {
	for (const [input, expected] of [
		["9.223372036854775807e18", "9223372036854775807"],
		["-9.223372036854775808e18", "-9223372036854775808"],
		["1.2e1", "12"],
		["0e999999", "0"],
	]) {
		expect(LogValue.parse({ intValue: input })).toEqual({ intValue: expected });
	}
	for (const invalid of [
		"1e999999999",
		"1.5",
		"9.223372036854775808e18",
		"1e-9999999",
		9007199254740992,
	]) {
		expect(LogValue.safeParse({ intValue: invalid }).success).toBe(false);
	}
});

test("negative zero remains JSON-safe in log AnyValues", () => {
	for (const value of ["-0", "-0.0e+3", -0]) {
		const parsed = LogValue.parse({ doubleValue: value });
		expect(JSON.stringify(parsed)).toBe('{"doubleValue":"-0"}');
	}
});

test("quoted finite AnyValue doubles normalize in logs", () => {
	expect(LogValue.parse({ doubleValue: "-1.25e2" })).toEqual({
		doubleValue: -125,
	});
	for (const invalid of [
		"",
		" ",
		"0x10",
		"nan",
		"1e9999",
		"1e",
		"1".repeat(129),
	]) {
		expect(LogValue.safeParse({ doubleValue: invalid }).success).toBe(false);
	}
	expect(
		ExportLogsRequest.parse(
			normalizeLogFields(envelope({ doubleValue: "0.5", stringValue: null })),
		).resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body,
	).toEqual({ doubleValue: 0.5 });
});

test("official-schema LogRecord field 12 event_name survives protobuf decoding", () => {
	// opentelemetry-proto logs/v1/logs.proto: event_name = 12. This fixture is
	// independently reproduced by the hash-locked Python protobuf integration.
	const bytes = Buffer.from("0a09120712056203657674", "hex");
	const parsed = ExportLogsRequest.parse(
		normalizeLogFields(decodeLogExport(bytes), "request", 0, true),
	);
	expect(parsed.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.eventName).toBe(
		"evt",
	);
});

test("logs retain the full uint64 timestamp and signed int64 body domain without Number rounding", () => {
	const parsed = ExportLogsRequest.parse(
		envelope({ intValue: "-9223372036854775808" }),
	);
	expect(parsed.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]).toMatchObject({
		timeUnixNano: "18446744073709551615",
		body: { intValue: "-9223372036854775808" },
	});
	for (const timestamp of [
		"18446744073709551616",
		"1.5",
		-1,
		9007199254740992,
	]) {
		expect(ExportLogsRequest.safeParse(envelope({}, timestamp)).success).toBe(
			false,
		);
	}
	expect(logFilterNano("2023-11-14T22:13:20.123456789Z")).toBe(
		1700000000123456789n,
	);
});

test("empty and special floating AnyValues survive while multi-oneof values reject", () => {
	for (const body of [
		{},
		{ doubleValue: "NaN" },
		{ doubleValue: "Infinity" },
		{ bytesValue: "AP-A" },
	]) {
		expect(ExportLogsRequest.safeParse(envelope(body)).success).toBe(true);
	}
	expect(
		ExportLogsRequest.safeParse(envelope({ stringValue: "x", boolValue: true }))
			.success,
	).toBe(false);
	expect(
		ExportLogsRequest.safeParse(
			envelope({ arrayValue: { values: [{ boolValue: "true" }] } }),
		).success,
	).toBe(false);
	expect(
		ExportLogsRequest.safeParse(
			normalizeLogFields(envelope({ bytesValue: [0, 255] })),
		).success,
	).toBe(false);
});

test("known nulls normalize, null repeated elements reject, and prototype extension keys cannot create records", () => {
	expect(
		ExportLogsRequest.safeParse(normalizeLogFields({ resourceLogs: null }))
			.success,
	).toBe(true);
	expect(() => normalizeLogFields({ resourceLogs: [null] })).toThrow();
	const input = JSON.parse(
		'{"__proto__":{"resourceLogs":[{"scopeLogs":[{"logRecords":[{}]}]}]}}',
	);
	expect(
		ExportLogsRequest.parse(normalizeLogFields(input)).resourceLogs,
	).toEqual([]);
});

test("redaction drops unknown deep branches without discarding inspectable siblings or empty AnyValues", () => {
	let extension: unknown = { secret: "do-not-retain" };
	for (let index = 0; index < 20_000; index++)
		extension = { values: [extension] };
	const body = {
		arrayValue: {
			values: [
				{ stringValue: "drop-me", extension },
				{},
				{
					kvlistValue: {
						values: [
							{ key: "secret", value: { stringValue: "do-not-retain" } },
							{ key: "safe", value: { intValue: "9223372036854775807" } },
						],
					},
				},
			],
		},
	} as LogAnyValue;
	const retained = redactLogValue(body, new Set(["secret"]));
	expect(retained).toEqual({
		arrayValue: {
			values: [
				{},
				{
					kvlistValue: {
						values: [
							{ key: "safe", value: { intValue: "9223372036854775807" } },
						],
					},
				},
			],
		},
	});
	expect(JSON.stringify(retained)).not.toContain("do-not-retain");
});
