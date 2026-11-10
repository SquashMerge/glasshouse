import { expect, test } from "bun:test";
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
