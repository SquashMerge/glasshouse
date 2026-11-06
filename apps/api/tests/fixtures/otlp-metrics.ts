import protobufRoot from "@opentelemetry/otlp-proto-exporter-base/build/src/generated/root.js";

export const metricTime = "1793880000123456789";
export const metricStart = "1793880000123456001";
export const exemplarTime = "1793880000123456703";
export const exemplarTrace = "00112233445566778899aabbccddeeff";
export const exemplarSpan = "0011223344556677";

export type Attribute = { key: string; value: Record<string, unknown> };
export type Metric = {
	name: string;
	description?: string;
	unit?: string;
	gauge?: { dataPoints: Record<string, unknown>[] };
	sum?: {
		dataPoints: Record<string, unknown>[];
		aggregationTemporality: number;
		isMonotonic: boolean;
	};
	histogram?: {
		dataPoints: Record<string, unknown>[];
		aggregationTemporality: number;
	};
	exponentialHistogram?: {
		dataPoints: Record<string, unknown>[];
		aggregationTemporality: number;
	};
	summary?: { dataPoints: Record<string, unknown>[] };
};

export const stringAttribute = (key: string, value: string): Attribute => ({
	key,
	value: { stringValue: value },
});

export function exemplar() {
	return {
		timeUnixNano: exemplarTime,
		asDouble: 1.5,
		traceId: exemplarTrace,
		spanId: exemplarSpan,
		filteredAttributes: [stringAttribute("sample", "retained")],
	};
}

export function numberPoint(attributes: Attribute[] = []) {
	return {
		attributes,
		startTimeUnixNano: metricStart,
		timeUnixNano: metricTime,
		asInt: "9007199254740993",
	};
}

export function gauge(name: string, attributes: Attribute[] = []): Metric {
	return { name, unit: "1", gauge: { dataPoints: [numberPoint(attributes)] } };
}

export function histogram(name: string): Metric {
	return {
		name,
		unit: "s",
		histogram: {
			aggregationTemporality: 1,
			dataPoints: [
				{
					attributes: [],
					startTimeUnixNano: metricStart,
					timeUnixNano: metricTime,
					count: "4",
					sum: 7,
					min: 0,
					max: 4,
					bucketCounts: ["1", "2", "1"],
					explicitBounds: [1, 2],
					exemplars: [exemplar()],
				},
			],
		},
	};
}

export function metricKinds(prefix: string): Metric[] {
	return [
		gauge(`${prefix}.gauge`),
		{
			name: `${prefix}.sum`,
			unit: "{request}",
			sum: {
				aggregationTemporality: 2,
				isMonotonic: true,
				dataPoints: [numberPoint()],
			},
		},
		histogram(`${prefix}.histogram`),
		{
			name: `${prefix}.exponential_histogram`,
			exponentialHistogram: {
				aggregationTemporality: 2,
				dataPoints: [
					{
						startTimeUnixNano: metricStart,
						timeUnixNano: metricTime,
						count: "6",
						sum: -2.375,
						scale: -1,
						zeroCount: "1",
						zeroThreshold: 0.001,
						positive: { offset: -2, bucketCounts: ["1", "2"] },
						negative: { offset: 0, bucketCounts: ["2"] },
						min: -2,
						max: 0.5,
					},
				],
			},
		},
		{
			name: `${prefix}.summary`,
			summary: {
				dataPoints: [
					{
						startTimeUnixNano: metricStart,
						timeUnixNano: metricTime,
						count: "4",
						sum: 7,
						quantileValues: [
							{ quantile: 0.5, value: 1.5 },
							{ quantile: 1, value: 4 },
						],
					},
				],
			},
		},
	];
}

export function metricExport(
	metrics: Metric[],
	resourceAttributes: Attribute[] = [],
	scope = {
		name: "glasshouse.metrics.regression",
		version: "1.0.0",
		attributes: [stringAttribute("scope.label", "retained")],
	},
) {
	return {
		resourceMetrics: [
			{
				schemaUrl: "https://opentelemetry.io/schemas/1.25.0",
				resource: { attributes: resourceAttributes },
				scopeMetrics: [
					{
						schemaUrl: "https://opentelemetry.io/schemas/1.26.0",
						scope,
						metrics,
					},
				],
			},
		],
	};
}

type Message = {
	fromObject: (value: object) => object;
	encode: (value: object) => { finish: () => Uint8Array };
	decode: (value: Uint8Array) => { toJSON: () => Record<string, unknown> };
};
const messages = (
	protobufRoot as unknown as {
		opentelemetry: {
			proto: {
				collector: {
					metrics: {
						v1: {
							ExportMetricsServiceRequest: Message;
							ExportMetricsServiceResponse: Message;
						};
					};
				};
			};
		};
	}
).opentelemetry.proto.collector.metrics.v1;

export function metricsProtobuf(payload: ReturnType<typeof metricExport>) {
	const wire = structuredClone(payload);
	for (const resource of wire.resourceMetrics) {
		for (const scope of resource.scopeMetrics) {
			for (const metric of scope.metrics) {
				for (const data of [metric.gauge, metric.sum, metric.histogram]) {
					for (const point of data?.dataPoints ?? []) {
						for (const sample of (point.exemplars ?? []) as Record<
							string,
							unknown
						>[]) {
							for (const key of ["traceId", "spanId"]) {
								if (typeof sample[key] === "string")
									sample[key] = Buffer.from(sample[key], "hex");
							}
						}
					}
				}
			}
		}
	}
	return Buffer.from(
		messages.ExportMetricsServiceRequest.encode(
			messages.ExportMetricsServiceRequest.fromObject(wire),
		).finish(),
	);
}

export const decodeMetricsResponse = (bytes: Uint8Array) =>
	messages.ExportMetricsServiceResponse.decode(bytes).toJSON();
