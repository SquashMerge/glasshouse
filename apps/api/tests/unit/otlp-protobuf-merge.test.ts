import { expect, test } from "bun:test";
import {
	decodeLogExport,
	normalizeLogFields,
} from "../../src/lib/otlp-logs.js";
import { decodeOtlpTraceExport } from "../../src/lib/otlp-protobuf.js";
import { ExportLogsRequest } from "../../src/schemas/logs.js";

// Expected values were independently decoded with the generated Python
// opentelemetry-proto 1.39.1 classes and protobuf 6.33.6.
const cases = [
	{
		name: "duplicate singular messages merge repeated arrays",
		trace:
			"0a26122412224a200a036b6579120b2a090a070a056669727374120c2a0a0a080a067365636f6e64",
		log: "0a261224122232200a036b6579120b2a090a070a056669727374120c2a0a0a080a067365636f6e64",
		expected: {
			arrayValue: {
				values: [{ stringValue: "first" }, { stringValue: "second" }],
			},
		},
	},
	{
		name: "oneof switch resets an earlier message even across singular message boundaries",
		trace:
			"0a25122312214a1f0a036b657912092a070a050a036f6c641202100012092a070a050a036e6577",
		log: "0a2512231221321f0a036b657912092a070a050a036f6c641202100012092a070a050a036e6577",
		expected: { arrayValue: { values: [{ stringValue: "new" }] } },
	},
	{
		name: "alternating scalar oneof preserves wire order",
		trace: "0a1c121a12184a160a036b6579120f0a05666972737410000a046c617374",
		log: "0a1c121a121832160a036b6579120f0a05666972737410000a046c617374",
		expected: { stringValue: "last" },
	},
];
for (const [signal, decode] of [
	["trace", decodeOtlpTraceExport],
	["log", decodeLogExport],
] as const) {
	test(`${signal} decoder rejects an unknown group with a mismatched end tag`, () => {
		expect(() => decode(Buffer.from("0b14", "hex"))).toThrow();
	});

	// Generated Python OTLP requests with protobuf 6.33.6 reject varints
	// longer than ten bytes, including in unknown groups and nested messages.
	for (const hex of [
		`a006${"80".repeat(10)}00`,
		`a306a806${"80".repeat(10)}00a406`,
		`0a0da006${"80".repeat(10)}00`,
		`08${"80".repeat(10)}00`, // known message field, wrong wire type
		`a006${"80".repeat(10)}`, // unterminated at the ten-byte limit
		"a00680", // truncated
	]) {
		test(`${signal} rejects overlong unknown varint ${hex}`, () => {
			expect(() => decode(Buffer.from(hex, "hex"))).toThrow();
		});
	}
	for (const hex of [
		`a006${"ff".repeat(9)}01`, // 64-bit signed -1
		`a006${"80".repeat(9)}02`, // protobuf accepts high bits in byte ten
		`a306a806${"ff".repeat(9)}01a406`,
	]) {
		test(`${signal} accepts ten-byte unknown varint ${hex}`, () => {
			expect(() => decode(Buffer.from(hex, "hex"))).not.toThrow();
		});
	}

	// Oracle: opentelemetry-proto 1.39.1, google protobuf 6.33.6.
	for (const hex of [
		"0b0c", // known message field, wrong wire type, matching end
		"0b13140c", // nested groups with distinct field numbers
		"0b08010c", // varint within group
		"a306ab06ac06a406", // multi-byte group field numbers
		"a00601", // unknown non-group field
	]) {
		test(`${signal} accepts well-formed unknown field ${hex}`, () => {
			expect(() => decode(Buffer.from(hex, "hex"))).not.toThrow();
		});
	}
	for (const hex of [
		"0b131c0c", // nested mismatch
		"0b", // missing terminator
		"0c", // stray end group
		"0b0e0c", // invalid wire type in group
		"0b000c", // invalid zero field number in group
		"0b8c01", // field 1 start, field 17 end (same low tag byte)
		"0a020b14", // mismatch inside a known message
	]) {
		test(`${signal} rejects malformed group ${hex}`, () => {
			expect(() => decode(Buffer.from(hex, "hex"))).toThrow();
		});
	}
	test(`${signal} rejects a group split across singular message occurrences`, () => {
		expect(() => decode(Buffer.from("0a060a010b0a010c", "hex"))).toThrow();
	});

	test(`${signal} bounds group nesting`, () => {
		const group = (depth: number) =>
			Buffer.concat([
				Buffer.from("a306".repeat(depth), "hex"),
				Buffer.from("a406".repeat(depth), "hex"),
			]);
		expect(() => decode(group(64))).not.toThrow();
		expect(() => decode(group(65))).toThrow();
		expect(() => decode(group(20_000))).toThrow();
	}, 1000);
}

test("official protobuf negative int64 fixtures preserve their signed value", () => {
	const trace = decodeOtlpTraceExport(
		Buffer.from("0a16121412124a100a016b120b18ffffffffffffffffff01", "hex"),
	) as any;
	const log = decodeLogExport(
		Buffer.from("0a161214121232100a016b120b18ffffffffffffffffff01", "hex"),
	) as any;
	expect(
		trace.resourceSpans[0].scopeSpans[0].spans[0].attributes[0].value.intValue,
	).toBe("-1");
	expect(
		log.resourceLogs[0].scopeLogs[0].logRecords[0].attributes[0].value.intValue,
	).toBe("-1");
});

for (const fixture of cases) {
	test(`official protobuf oracle: ${fixture.name} for traces and logs`, () => {
		const trace = decodeOtlpTraceExport(
			Buffer.from(fixture.trace, "hex"),
		) as any;
		expect(
			trace.resourceSpans[0].scopeSpans[0].spans[0].attributes[0].value,
		).toEqual(fixture.expected);
		const log = ExportLogsRequest.parse(
			normalizeLogFields(
				decodeLogExport(Buffer.from(fixture.log, "hex")),
				"request",
				0,
				true,
			),
		);
		expect(
			log.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.attributes[0]?.value,
		).toEqual(fixture.expected);
	});
}
