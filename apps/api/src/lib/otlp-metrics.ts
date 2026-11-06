import { createHmac } from "node:crypto";
import { resourceProjectId } from "../db/gen-ai-attrs.js";
import type { OtlpAttribute } from "../db/observation-metadata.js";

export const METRIC_LIMITS = {
	resources: 128,
	scopesPerResource: 128,
	metrics: 2_000,
	points: 2_000,
	attributes: 128,
	buckets: 4_096,
	exemplars: 32,
	quantiles: 1_024,
	depth: 32,
	nodes: 100_000,
	rowBytes: 65_536,
	batchBytes: 4_194_304,
} as const;

type ObjectValue = Record<string, unknown>;
export type MetricAttribute = { key: string; value?: ObjectValue };
export type MetricKind =
	| "gauge"
	| "sum"
	| "histogram"
	| "exponential_histogram"
	| "summary";
export type MetricPoint = {
	name: string;
	description: string;
	unit: string;
	metric_type: MetricKind;
	aggregation_temporality: number;
	is_monotonic: boolean;
	resource_attributes: MetricAttribute[];
	resource_dropped_attributes_count: number;
	resource_schema_url: string;
	scope_name: string;
	scope_version: string;
	scope_attributes: MetricAttribute[];
	scope_dropped_attributes_count: number;
	scope_schema_url: string;
	metric_metadata: MetricAttribute[];
	data_point: ObjectValue;
};

export class InvalidMetricExport extends Error {
	constructor() {
		super("Invalid metrics export");
	}
}
export class MetricProjectConflict extends Error {}
function invalid(): never {
	throw new InvalidMetricExport();
}
function object(value: unknown): ObjectValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return invalid();
	return value as ObjectValue;
}
function list(value: unknown, max: number): unknown[] {
	if (value == null) return [];
	if (
		!Array.isArray(value) ||
		value.length > max ||
		value.some((v) => v === null)
	)
		return invalid();
	return value;
}
function text(value: unknown, max: number, fallback = ""): string {
	if (value == null) return fallback;
	if (typeof value !== "string" || Buffer.byteLength(value) > max)
		return invalid();
	return value;
}
function integer(
	value: unknown,
	min: number,
	max: number,
	fallback = 0,
): number {
	if (value == null) return fallback;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < min ||
		value > max
	)
		return invalid();
	return value;
}
function finite(value: unknown): number {
	const parsed = double(value);
	if (typeof parsed !== "number" || !Number.isFinite(parsed)) return invalid();
	return parsed;
}
function double(value: unknown): number | string {
	if (value === "NaN" || value === "Infinity" || value === "-Infinity")
		return value;
	if (typeof value === "string") {
		if (
			value.length > 128 ||
			!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
		)
			return invalid();
		value = Number(value);
		if (!Number.isFinite(value)) return invalid();
	}
	if (typeof value !== "number") return invalid();
	if (Object.is(value, -0)) return "-0";
	return Number.isFinite(value) ? value : String(value);
}
function int64(value: unknown, signed = false): string {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) return invalid();
		value = String(value);
	}
	if (typeof value !== "string" || !/^-?\d{1,20}$/.test(value))
		return invalid();
	const number = BigInt(value);
	if (
		number < (signed ? -(1n << 63n) : 0n) ||
		number > (signed ? (1n << 63n) - 1n : (1n << 64n) - 1n)
	)
		return invalid();
	return number.toString();
}

type Budget = { nodes: number };
function visit(budget: Budget, depth: number) {
	if (depth > METRIC_LIMITS.depth || --budget.nodes < 0) invalid();
}
function attributes(
	value: unknown,
	budget: Budget,
	depth: number,
): MetricAttribute[] {
	visit(budget, depth);
	const keys = new Set<string>();
	return list(value, METRIC_LIMITS.attributes).map((item) => {
		visit(budget, depth + 1);
		const source = object(item);
		const key = text(source.key, 256);
		if (!key || keys.has(key)) return invalid();
		keys.add(key);
		return source.value == null
			? { key }
			: { key, value: anyValue(source.value, budget, depth + 2) };
	});
}
function anyValue(value: unknown, budget: Budget, depth: number): ObjectValue {
	visit(budget, depth);
	const source = object(value);
	const fields = [
		"stringValue",
		"boolValue",
		"intValue",
		"doubleValue",
		"bytesValue",
		"arrayValue",
		"kvlistValue",
	].filter((key) => source[key] != null);
	if (fields.length === 0) return {};
	if (fields.length !== 1) return invalid();
	const key = fields[0]!;
	const child = source[key];
	if (key === "stringValue") return { stringValue: text(child, 8_192) };
	if (key === "intValue") return { intValue: int64(child, true) };
	if (key === "doubleValue") return { doubleValue: double(child) };
	if (key === "boolValue") {
		if (typeof child !== "boolean") return invalid();
		return { boolValue: child };
	}
	if (key === "bytesValue") {
		if (Array.isArray(child) && !child.every(isByte)) return invalid();
		const bytes = Array.isArray(child)
			? Buffer.from(child).toString("base64")
			: text(child, 16_384);
		if (
			bytes.length > 16_384 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				bytes,
			)
		)
			return invalid();
		return { bytesValue: Buffer.from(bytes, "base64").toString("base64") };
	}
	visit(budget, depth + 1);
	const collection = object(child);
	return key === "kvlistValue"
		? {
				kvlistValue: {
					values: attributes(collection.values, budget, depth + 2),
				},
			}
		: {
				arrayValue: {
					values: list(collection.values, 128).map((v) =>
						anyValue(v, budget, depth + 2),
					),
				},
			};
}

function isByte(value: unknown): boolean {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= 255
	);
}

function numberValue(
	source: ObjectValue,
	target: ObjectValue,
	optional: boolean,
) {
	const hasInt = source.asInt != null;
	const hasDouble = source.asDouble != null;
	if ((hasInt && hasDouble) || (!optional && !hasInt && !hasDouble)) invalid();
	if (hasInt) target.asInt = int64(source.asInt, true);
	if (hasDouble) target.asDouble = double(source.asDouble);
}
function id(value: unknown, length: number): string {
	if (Array.isArray(value)) {
		if (!value.every(isByte)) return invalid();
		value = Buffer.from(value).toString("hex");
	}
	if (
		typeof value !== "string" ||
		!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value) ||
		/^0+$/.test(value)
	)
		return invalid();
	return value.toLowerCase();
}
function point(value: unknown, kind: MetricKind, budget: Budget): ObjectValue {
	visit(budget, 7);
	const source = object(value);
	const time = int64(source.timeUnixNano);
	const start = int64(source.startTimeUnixNano ?? "0");
	if (time === "0" || BigInt(start) > BigInt(time)) return invalid();
	const flags = integer(source.flags, 0, 4_294_967_295);
	const result: ObjectValue = {
		attributes: attributes(source.attributes, budget, 8),
		timeUnixNano: time,
	};
	if (source.startTimeUnixNano != null) result.startTimeUnixNano = start;
	if (source.flags != null) result.flags = flags;
	if (kind === "gauge" || kind === "sum")
		numberValue(source, result, !!(flags & 1));
	else {
		result.count = int64(source.count ?? "0");
		for (const key of ["sum", "min", "max"])
			if (source[key] != null) result[key] = double(source[key]);
		if (
			result.min !== undefined &&
			result.max !== undefined &&
			Number(result.min) > Number(result.max)
		)
			invalid();
		if (
			result.count === "0" &&
			result.sum !== undefined &&
			Number(result.sum) !== 0
		)
			invalid();
		if (kind === "histogram") {
			const bounds = list(source.explicitBounds, METRIC_LIMITS.buckets - 1).map(
				(n) => {
					visit(budget, 8);
					return finite(n);
				},
			);
			const buckets = list(source.bucketCounts, METRIC_LIMITS.buckets).map(
				(n) => {
					visit(budget, 8);
					return int64(n);
				},
			);
			if (
				bounds.some((n, i) => i > 0 && n <= bounds[i - 1]!) ||
				(buckets.length
					? buckets.length !== bounds.length + 1
					: bounds.length !== 0)
			)
				invalid();
			if (
				buckets.length &&
				buckets.reduce((n, v) => n + BigInt(v), 0n) !==
					BigInt(result.count as string)
			)
				invalid();
			result.explicitBounds = bounds;
			result.bucketCounts = buckets;
		} else if (kind === "exponential_histogram") {
			result.scale = integer(source.scale, -2_147_483_648, 2_147_483_647);
			result.zeroCount = int64(source.zeroCount ?? "0");
			let count = BigInt(result.zeroCount as string);
			let bucketCount = 0;
			for (const side of ["positive", "negative"]) {
				if (source[side] == null) continue;
				const buckets = object(source[side]);
				const values = list(buckets.bucketCounts, METRIC_LIMITS.buckets).map(
					(n) => {
						visit(budget, 9);
						return int64(n);
					},
				);
				bucketCount += values.length;
				count += values.reduce((n, v) => n + BigInt(v), 0n);
				const offset = integer(buckets.offset, -2_147_483_648, 2_147_483_647);
				if (offset + values.length > 2_147_483_648) invalid();
				result[side] = { offset, bucketCounts: values };
			}
			if (
				bucketCount > METRIC_LIMITS.buckets ||
				count !== BigInt(result.count as string)
			)
				invalid();
			if (source.zeroThreshold != null) {
				result.zeroThreshold = finite(source.zeroThreshold);
				if (Number(result.zeroThreshold) < 0) invalid();
			}
		} else {
			let previous = -1;
			result.quantileValues = list(
				source.quantileValues,
				METRIC_LIMITS.quantiles,
			).map((v) => {
				visit(budget, 8);
				const entry = object(v);
				const quantile = finite(entry.quantile ?? 0);
				if (quantile < 0 || quantile > 1 || quantile <= previous) invalid();
				previous = quantile;
				const value = finite(entry.value ?? 0);
				if (value < 0) invalid();
				return { quantile, value };
			});
		}
	}
	if (kind !== "summary") {
		result.exemplars = list(source.exemplars, METRIC_LIMITS.exemplars).map(
			(v) => {
				visit(budget, 8);
				const sample = object(v);
				const sampleTime = int64(sample.timeUnixNano);
				if (
					sampleTime === "0" ||
					BigInt(sampleTime) < BigInt(start) ||
					BigInt(sampleTime) > BigInt(time)
				)
					invalid();
				const output: ObjectValue = {
					timeUnixNano: sampleTime,
					filteredAttributes: attributes(sample.filteredAttributes, budget, 9),
				};
				numberValue(sample, output, false);
				for (const [key, length] of [
					["traceId", 32],
					["spanId", 16],
				] as const) {
					const value = sample[key];
					if (
						value != null &&
						value !== "" &&
						!(Array.isArray(value) && !value.length)
					)
						output[key] = id(value, length);
				}
				return output;
			},
		);
	}
	return result;
}

const kinds = {
	gauge: "gauge",
	sum: "sum",
	histogram: "histogram",
	exponentialHistogram: "exponential_histogram",
	summary: "summary",
} as const;
export function normalizeMetricExport(
	value: unknown,
	expectedProjectId?: string,
): MetricPoint[] {
	const budget = { nodes: METRIC_LIMITS.nodes };
	const output: MetricPoint[] = [];
	let metrics = 0;
	let expandedBytes = 0;
	for (const entry of list(
		object(value).resourceMetrics,
		METRIC_LIMITS.resources,
	)) {
		visit(budget, 2);
		const resourceMetrics = object(entry);
		const resource: ObjectValue =
			resourceMetrics.resource == null ? {} : object(resourceMetrics.resource);
		const resource_attributes = attributes(resource.attributes, budget, 3);
		let selected: string;
		try {
			selected = resourceProjectId(
				list(resource.attributes, METRIC_LIMITS.attributes) as OtlpAttribute[],
			);
		} catch {
			return invalid();
		}
		if (selected && expectedProjectId && selected !== expectedProjectId)
			throw new MetricProjectConflict();
		const resource_schema_url = text(resourceMetrics.schemaUrl, 2_048);
		for (const entry of list(
			resourceMetrics.scopeMetrics,
			METRIC_LIMITS.scopesPerResource,
		)) {
			visit(budget, 4);
			const scopeMetrics = object(entry);
			const scope: ObjectValue =
				scopeMetrics.scope == null ? {} : object(scopeMetrics.scope);
			const context = {
				resource_attributes,
				resource_schema_url,
				resource_dropped_attributes_count: integer(
					resource.droppedAttributesCount,
					0,
					4_294_967_295,
				),
				scope_name: text(scope.name, 1_024),
				scope_version: text(scope.version, 256),
				scope_attributes: attributes(scope.attributes, budget, 5),
				scope_dropped_attributes_count: integer(
					scope.droppedAttributesCount,
					0,
					4_294_967_295,
				),
				scope_schema_url: text(scopeMetrics.schemaUrl, 2_048),
			};
			for (const entry of list(scopeMetrics.metrics, METRIC_LIMITS.metrics)) {
				visit(budget, 6);
				if (++metrics > METRIC_LIMITS.metrics) invalid();
				const metric = object(entry);
				const fields = (Object.keys(kinds) as (keyof typeof kinds)[]).filter(
					(key) => metric[key] != null,
				);
				if (fields.length !== 1) return invalid();
				const field = fields[0]!;
				const kind = kinds[field];
				const data = object(metric[field]);
				const name = text(metric.name, 1_024);
				if (!name) invalid();
				const temporality =
					kind === "gauge" || kind === "summary"
						? 0
						: integer(data.aggregationTemporality, 1, 2, -1);
				if (temporality < 0) invalid();
				if (data.isMonotonic != null && typeof data.isMonotonic !== "boolean")
					invalid();
				const metadata = attributes(metric.metadata, budget, 7);
				for (const entry of list(data.dataPoints, METRIC_LIMITS.points)) {
					if (output.length >= METRIC_LIMITS.points) invalid();
					const data_point = point(entry, kind, budget);
					if (
						kind === "sum" &&
						data.isMonotonic === true &&
						(BigInt(String(data_point.asInt ?? "0")) < 0n ||
							Number(data_point.asDouble ?? 0) < 0)
					)
						invalid();
					const normalized: MetricPoint = {
						...context,
						name,
						description: text(metric.description, 8_192),
						unit: text(metric.unit, 256),
						metric_type: kind,
						aggregation_temporality: temporality,
						is_monotonic: kind === "sum" && data.isMonotonic === true,
						metric_metadata: metadata,
						data_point,
					};
					// Shared resource/scope data can amplify a small wire export when
					// expanded per point. Bound it before hashing or redacting each row.
					const size = Buffer.byteLength(JSON.stringify(normalized));
					expandedBytes += size;
					if (
						size > METRIC_LIMITS.rowBytes ||
						expandedBytes > METRIC_LIMITS.batchBytes
					)
						invalid();
					output.push(normalized);
				}
			}
		}
	}
	return output;
}

function canonicalAttributes(attrs: MetricAttribute[]): unknown {
	return [...attrs]
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
		.map((a) => [a.key, canonicalValue(a.value)]);
}
function canonicalValue(value: ObjectValue | undefined): unknown {
	if (!value || Object.keys(value).length === 0) return null;
	if (value.kvlistValue)
		return [
			"kvlistValue",
			canonicalAttributes(
				(value.kvlistValue as { values: MetricAttribute[] }).values,
			),
		];
	if (value.arrayValue)
		return [
			"arrayValue",
			(value.arrayValue as { values: ObjectValue[] }).values.map(
				canonicalValue,
			),
		];
	return Object.entries(value);
}
export function metricSeriesId(
	point: MetricPoint,
	organizationId: string,
	projectId: string,
	key: Buffer,
): string {
	// A public digest of pre-redaction labels permits offline dictionary attacks.
	return createHmac("sha256", key)
		.update(
			JSON.stringify([
				"metrics-series-v2",
				organizationId,
				projectId,
				point.name,
				point.unit,
				point.metric_type,
				point.aggregation_temporality,
				point.is_monotonic,
				point.resource_schema_url,
				canonicalAttributes(point.resource_attributes),
				point.scope_name,
				point.scope_version,
				point.scope_schema_url,
				canonicalAttributes(point.scope_attributes),
				canonicalAttributes(point.data_point.attributes as MetricAttribute[]),
			]),
		)
		.digest("hex");
}

export function redactMetricPoint(
	point: MetricPoint,
	keys: string[],
	allText: boolean,
): MetricPoint {
	const denied = new Set(keys);
	const attrs = (values: MetricAttribute[]): MetricAttribute[] =>
		values
			.filter((v) => !denied.has(v.key))
			.map((v) => (v.value ? { key: v.key, value: redactValue(v.value) } : v));
	const redactValue = (value: ObjectValue): ObjectValue => {
		if (value.kvlistValue)
			return {
				kvlistValue: {
					values: attrs(
						(value.kvlistValue as { values: MetricAttribute[] }).values,
					),
				},
			};
		if (value.arrayValue)
			return {
				arrayValue: {
					values: (value.arrayValue as { values: ObjectValue[] }).values.map(
						redactValue,
					),
				},
			};
		if (
			allText &&
			(value.stringValue !== undefined || value.bytesValue !== undefined)
		)
			return { stringValue: "[REDACTED]" };
		return value;
	};
	return {
		...point,
		description:
			allText && point.description ? "[REDACTED]" : point.description,
		resource_attributes: attrs(point.resource_attributes),
		scope_attributes: attrs(point.scope_attributes),
		metric_metadata: attrs(point.metric_metadata),
		data_point: {
			...point.data_point,
			attributes: attrs(point.data_point.attributes as MetricAttribute[]),
			...(point.data_point.exemplars
				? {
						exemplars: (point.data_point.exemplars as ObjectValue[]).map(
							(v) => ({
								...v,
								filteredAttributes: attrs(
									v.filteredAttributes as MetricAttribute[],
								),
							}),
						),
					}
				: {}),
		},
	};
}
