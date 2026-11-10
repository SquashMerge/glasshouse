import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	METRIC_LIMITS,
	metricSeriesId,
	normalizeMetricExport,
	redactMetricPoint,
} from "../../src/lib/otlp-metrics.js";
import { decodeOtlpMetricExport } from "../../src/lib/otlp-protobuf.js";
import {
	gauge,
	histogram,
	metricExport,
	metricKinds,
	numberPoint,
	stringAttribute,
} from "../fixtures/otlp-metrics.js";

const identityKey = randomBytes(32);

test("metric byte labels accept ProtoJSON base64 variants and canonicalize identity", () => {
	const make = (bytesValue: string) =>
		normalizeMetricExport(
			metricExport([gauge("bytes", [{ key: "label", value: { bytesValue } }])]),
		)[0]!;
	const canonical = make("+/8=");
	for (const variant of ["+/8", "-_8=", "-_8"]) {
		const point = make(variant);
		expect(point.data_point.attributes).toEqual(
			canonical.data_point.attributes,
		);
		expect(metricSeriesId(point, "org", "project", identityKey)).toBe(
			metricSeriesId(canonical, "org", "project", identityKey),
		);
	}
	for (const invalid of ["A", "AA=", "AA===", "A A=", "AA$="]) {
		expect(() => make(invalid)).toThrow();
	}
});

test("all kinds preserve lossless values through recursive normalization", () => {
	const rows = normalizeMetricExport(metricExport(metricKinds("test")));
	expect(rows.map((row) => row.metric_type)).toEqual([
		"gauge",
		"sum",
		"histogram",
		"exponential_histogram",
		"summary",
	]);
	expect(rows[0]!.data_point.asInt).toBe("9007199254740993");
	expect(rows[0]!.data_point.timeUnixNano).toBe("1793880000123456789");
});

test("unknown deep extensions are ignored without traversing or persisting them", () => {
	let extension: unknown = "secret";
	for (let i = 0; i < 1_000; i++) extension = { extension };
	const payload = metricExport([gauge("safe")]);
	Object.assign(payload, { extension });
	Object.assign(payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!, {
		extension,
	});
	expect(JSON.stringify(normalizeMetricExport(payload))).not.toContain(
		"secret",
	);
});

test("known recursive attributes cannot bypass depth and collection budgets", () => {
	let value: Record<string, unknown> = { stringValue: "deep" };
	for (let i = 0; i < METRIC_LIMITS.depth; i++)
		value = { arrayValue: { values: [value] } };
	expect(() =>
		normalizeMetricExport(
			metricExport([gauge("deep", [{ key: "nested", value }])]),
		),
	).toThrow();
	const metric = histogram("wide");
	metric.histogram!.dataPoints[0]!.exemplars = Array(
		METRIC_LIMITS.exemplars + 1,
	).fill({});
	expect(() => normalizeMetricExport(metricExport([metric]))).toThrow();
	expect(() =>
		normalizeMetricExport(
			metricExport([
				{
					name: "many",
					gauge: {
						dataPoints: Array(METRIC_LIMITS.points + 1).fill(numberPoint()),
					},
				},
			]),
		),
	).toThrow();
});

test("duplicate keys, malformed doubles and unsafe integers reject instead of aliasing series", () => {
	const key = stringAttribute("duplicate", "value");
	expect(() =>
		normalizeMetricExport(metricExport([gauge("duplicate", [key, key])])),
	).toThrow();
	for (const value of ["nan", "1e9999", "", {}, []]) {
		expect(() =>
			normalizeMetricExport(
				metricExport([
					{
						name: "nonfinite",
						gauge: { dataPoints: [{ timeUnixNano: "1", asDouble: value }] },
					},
				]),
			),
		).toThrow();
	}
	for (const value of [9_007_199_254_740_992, "9223372036854775808"]) {
		expect(() =>
			normalizeMetricExport(
				metricExport([
					{
						name: "unsafe",
						gauge: { dataPoints: [{ timeUnixNano: "1", asInt: value }] },
					},
				]),
			),
		).toThrow();
	}
});

test("shared resource labels cannot amplify small exports into unbounded per-point work", () => {
	const resource = Array.from({ length: 6 }, (_, i) =>
		stringAttribute(`shared.${i}`, "x".repeat(8_192)),
	);
	const payload = metricExport(
		[
			{
				name: "amplified",
				gauge: { dataPoints: Array.from({ length: 100 }, () => numberPoint()) },
			},
		],
		resource,
	);
	expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(100_000);
	expect(() => normalizeMetricExport(payload)).toThrow();
});

test("redaction visits nested typed values and identity uses original attributes", () => {
	const make = (secret: string, reverse = false) => {
		const attrs = [
			stringAttribute("secret", secret),
			{
				key: "nested",
				value: {
					kvlistValue: {
						values: [
							stringAttribute("secret", secret),
							{ key: "safe", value: { boolValue: false } },
						],
					},
				},
			},
		];
		if (reverse) attrs.reverse();
		return normalizeMetricExport(metricExport([gauge("test", attrs)]))[0]!;
	};
	const original = make("sensitive");
	expect(metricSeriesId(original, "org", "project", identityKey)).toBe(
		metricSeriesId(make("sensitive", true), "org", "project", identityKey),
	);
	expect(metricSeriesId(original, "org", "project", identityKey)).not.toBe(
		metricSeriesId(make("other"), "org", "project", identityKey),
	);
	const redacted = redactMetricPoint(original, ["secret"], false);
	expect(JSON.stringify(redacted)).not.toContain("sensitive");
	expect(JSON.stringify(redacted)).not.toContain('"key":"secret"');
	expect(JSON.stringify(redacted)).toContain('"boolValue":false');
	expect(original.data_point.attributes).toHaveLength(2);
});

test("all_text removes string and byte attribute values in every metric context", () => {
	const attrs = [
		{ key: "bytes", value: { bytesValue: "c2VjcmV0" } },
		stringAttribute("text", "secret"),
	];
	const row = normalizeMetricExport(
		metricExport([gauge("structural-name", attrs)], attrs, {
			name: "scope",
			version: "1",
			attributes: attrs,
		}),
	)[0]!;
	const redacted = redactMetricPoint(row, [], true);
	expect(JSON.stringify(redacted)).not.toContain("c2VjcmV0");
	expect(JSON.stringify(redacted)).not.toContain("secret");
	expect(redacted.name).toBe("structural-name");
	expect(redacted.data_point.asInt).toBe("9007199254740993");
});

test("unset AnyValues and equivalent binary encodings have canonical series identity", () => {
	const normalized = (value?: Record<string, unknown>) =>
		normalizeMetricExport(
			metricExport([
				gauge("canonical", [{ key: "label", value: value ?? {} }]),
			]),
		)[0]!;
	const empty = normalized();
	const absent = structuredClone(empty);
	absent.data_point.attributes = [{ key: "label" }];
	expect(metricSeriesId(empty, "org", "project", identityKey)).toBe(
		metricSeriesId(absent, "org", "project", identityKey),
	);
	expect(
		metricSeriesId(
			normalized({ bytesValue: "AB==" }),
			"org",
			"project",
			identityKey,
		),
	).toBe(
		metricSeriesId(
			normalized({ bytesValue: "AA==" }),
			"org",
			"project",
			identityKey,
		),
	);
});

test("pre-redaction series identity requires a secret key, preventing an offline label dictionary", () => {
	const point = normalizeMetricExport(
		metricExport([gauge("private", [stringAttribute("secret", "yes")])]),
	)[0]!;
	const key = randomBytes(32);
	const otherKey = randomBytes(32);
	expect(metricSeriesId(point, "org", "project", key)).not.toBe(
		metricSeriesId(point, "org", "project", otherKey),
	);
	expect(metricSeriesId(point, "org", "project", key)).toBe(
		metricSeriesId(structuredClone(point), "org", "project", key),
	);
});

test("exponential histogram scale follows the protocol sint32, not an SDK aggregation range", () => {
	for (const scale of [-2_147_483_648, -11, 21, 2_147_483_647]) {
		const metric = metricKinds("scale")[3]!;
		metric.exponentialHistogram!.dataPoints[0]!.scale = scale;
		expect(
			normalizeMetricExport(metricExport([metric]))[0]!.data_point.scale,
		).toBe(scale);
	}
});

test("summary rejects negative quantile values as required by the wire contract", () => {
	const metric = metricKinds("summary")[4]!;
	metric.summary!.dataPoints[0]!.quantileValues = [
		{ quantile: 0.5, value: -1 },
	];
	expect(() => normalizeMetricExport(metricExport([metric]))).toThrow();
});

test("finite distribution fields keep strict numeric validation for quoted inputs", () => {
	const cases: [
		number,
		(point: Record<string, unknown>, value: unknown) => void,
	][] = [
		[
			2,
			(point, value) => {
				point.explicitBounds = [value, 2];
			},
		],
		[
			3,
			(point, value) => {
				point.zeroThreshold = value;
			},
		],
		[
			4,
			(point, value) => {
				point.quantileValues = [{ quantile: value, value: 1 }];
			},
		],
		[
			4,
			(point, value) => {
				point.quantileValues = [{ quantile: 0.5, value }];
			},
		],
	];
	for (const [index, set] of cases) {
		for (const value of [
			"",
			" ",
			"0x1",
			"1junk",
			"1e9999",
			"NaN",
			"Infinity",
			"-Infinity",
			"-0",
			"-0.0e2",
			"1".repeat(129),
			true,
			{},
			[],
			-0,
			NaN,
			Infinity,
			-Infinity,
		]) {
			const metric = metricKinds("finite")[index]!;
			const data =
				metric.histogram ?? metric.exponentialHistogram ?? metric.summary!;
			set(data.dataPoints[0]!, value);
			expect(() => normalizeMetricExport(metricExport([metric]))).toThrow();
		}
	}
	for (const [index, mutate] of [
		[
			2,
			(point: Record<string, unknown>) => {
				point.explicitBounds = ["1", "1.0"];
			},
		],
		[
			3,
			(point: Record<string, unknown>) => {
				point.zeroThreshold = "-1";
			},
		],
		[
			4,
			(point: Record<string, unknown>) => {
				point.quantileValues = [{ quantile: "1.01", value: "1" }];
			},
		],
		[
			4,
			(point: Record<string, unknown>) => {
				point.quantileValues = [{ quantile: "0.5", value: "-1" }];
			},
		],
	] as const) {
		const metric = metricKinds("invalid")[index]!;
		const data =
			metric.histogram ?? metric.exponentialHistogram ?? metric.summary!;
		mutate(data.dataPoints[0]!);
		expect(() => normalizeMetricExport(metricExport([metric]))).toThrow();
	}
});

test("OTLP special floating-point measurements keep a JSON-safe exact representation", () => {
	for (const [input, expected] of [
		[NaN, "NaN"],
		[Infinity, "Infinity"],
		[-Infinity, "-Infinity"],
		[-0, "-0"],
		["NaN", "NaN"],
		["Infinity", "Infinity"],
		["-Infinity", "-Infinity"],
	] as const) {
		const metric = {
			name: "double",
			gauge: { dataPoints: [{ timeUnixNano: "1", asDouble: input }] },
		};
		const row = normalizeMetricExport(metricExport([metric]))[0]!;
		expect(JSON.parse(JSON.stringify(row)).data_point.asDouble).toBe(expected);
	}
});

test("protobuf Metric metadata field 12 survives the older generated schema and is redacted", () => {
	// Independent wire fixture: Export.resource_metrics.scope_metrics.metrics,
	// Metric.name=1, gauge=5, metadata=12; Gauge.data_points=1.
	const message = (tag: number, bytes: Uint8Array) => {
		expect(bytes.length).toBeLessThan(128);
		return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
	};
	const label = (key: string, value: string) =>
		message(
			98,
			Buffer.concat([
				message(10, Buffer.from(key)),
				message(18, message(10, Buffer.from(value))),
			]),
		);
	const point = Buffer.from([
		25, 1, 0, 0, 0, 0, 0, 0, 0, 49, 1, 0, 0, 0, 0, 0, 0, 0,
	]);
	const metric = Buffer.concat([
		message(10, Buffer.from("metadata")),
		message(42, message(10, point)),
		label("secret", "sensitive"),
		label("safe", "retained"),
	]);
	const wire = message(10, message(18, message(18, metric)));
	const row = normalizeMetricExport(decodeOtlpMetricExport(wire))[0]!;
	expect(row.metric_metadata).toEqual([
		stringAttribute("secret", "sensitive"),
		stringAttribute("safe", "retained"),
	]);
	expect(redactMetricPoint(row, ["secret"], false).metric_metadata).toEqual([
		stringAttribute("safe", "retained"),
	]);
});
