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
