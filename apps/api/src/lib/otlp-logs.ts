import { parse, Root } from "protobufjs";
import common from "./otlp-proto/common.proto" with { type: "text" };
import resource from "./otlp-proto/resource.proto" with { type: "text" };
import logs from "./otlp-proto/logs.proto" with { type: "text" };
import service from "./otlp-proto/logs_service.proto" with { type: "text" };
import { mergeProtobufMessages } from "./protobuf-merge.js";
import {
	LOG_VALUE_KEYS,
	type LogAnyValue,
	type LogAttribute,
} from "../schemas/logs.js";

const root = new Root();
for (const source of [common, resource, logs, service]) parse(source, root);
const proto = root
	.resolveAll()
	.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest");

export function decodeLogExport(bytes: Uint8Array): unknown {
	return proto.toObject(proto.decode(mergeProtobufMessages(bytes, proto)), {
		arrays: true,
		bytes: Array,
		enums: Number,
		longs: String,
	});
}

const fields = {
	request: { resourceLogs: "resourceLogs" },
	resourceLogs: { resource: "resource", scopeLogs: "scopeLogs" },
	resource: { attributes: "attribute" },
	scopeLogs: { scope: "scope", logRecords: "record" },
	scope: { attributes: "attribute" },
	record: { body: "value", attributes: "attribute" },
	attribute: { value: "value" },
	value: { arrayValue: "arrayValue", kvlistValue: "kvlistValue" },
	arrayValue: { values: "value" },
	kvlistValue: { values: "attribute" },
} as const;
type Message = keyof typeof fields;

export function normalizeLogFields(
	value: unknown,
	message: Message = "request",
	depth = 0,
	protobuf = false,
): unknown {
	if (depth > 32) throw new Error("Log message nesting limit");
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value))
		return value.map((item) => {
			if (item === null) throw new Error("Null repeated element");
			return normalizeLogFields(item, message, depth + 1, protobuf);
		});
	const result: Record<string, unknown> = Object.create(null);
	for (const [key, child] of Object.entries(value)) {
		const known =
			message === "value"
				? LOG_VALUE_KEYS.has(key)
				: message === "attribute"
					? key === "key" || key === "value"
					: message === "arrayValue" || message === "kvlistValue"
						? key === "values"
						: true;
		if (child === null && known) continue;
		if (
			protobuf &&
			((message === "record" && (key === "traceId" || key === "spanId")) ||
				(message === "value" && key === "bytesValue")) &&
			Array.isArray(child)
		) {
			if (
				!child.every(
					(byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
				)
			)
				throw new Error("Invalid bytes");
			result[key] = Buffer.from(child).toString(
				key === "bytesValue" ? "base64" : "hex",
			);
		} else if (
			message === "value" &&
			key === "doubleValue" &&
			typeof child === "number" &&
			!Number.isFinite(child)
		) {
			result[key] = String(child);
		} else {
			const nested = (fields[message] as Readonly<Record<string, Message>>)[
				key
			];
			result[key] =
				Object.hasOwn(fields[message], key) && nested
					? normalizeLogFields(child, nested, depth + 1, protobuf)
					: child;
		}
	}
	return result;
}

type Budget = { remaining: number };
// Unknown extensions stay visible until this boundary, where an uninspectable
// branch is dropped. Never stringify the original exporter-controlled object.
export function redactLogValue(
	value: LogAnyValue,
	keys: ReadonlySet<string>,
	budget: Budget = { remaining: 4096 },
	depth = 0,
): LogAnyValue | null {
	if (depth > 32 || --budget.remaining < 0) return null;
	const names = Object.keys(value);
	if (names.some((key) => !LOG_VALUE_KEYS.has(key))) return null;
	if (!names.length) return {};
	if (value.arrayValue || value.kvlistValue) {
		const collection = value.arrayValue ?? value.kvlistValue!;
		if (Object.keys(collection).some((key) => key !== "values")) return null;
		if (value.arrayValue)
			return {
				arrayValue: {
					values: (value.arrayValue.values ?? []).flatMap((item) => {
						const retained = redactLogValue(item, keys, budget, depth + 1);
						return retained === null ? [] : [retained];
					}),
				},
			};
		return {
			kvlistValue: {
				values: redactLogAttributes(
					value.kvlistValue!.values ?? [],
					keys,
					budget,
					depth + 1,
				),
			},
		};
	}
	return value;
}

export function redactLogAttributes(
	attributes: LogAttribute[],
	keys: ReadonlySet<string>,
	budget: Budget = { remaining: 4096 },
	depth = 0,
): LogAttribute[] {
	return attributes.flatMap((attribute) => {
		if (
			depth > 32 ||
			--budget.remaining < 0 ||
			keys.has(attribute.key) ||
			Object.keys(attribute).some((key) => key !== "key" && key !== "value")
		)
			return [];
		if (!attribute.value) return [{ key: attribute.key }];
		const value = redactLogValue(attribute.value, keys, budget, depth + 1);
		return value === null ? [] : [{ key: attribute.key, value }];
	});
}
