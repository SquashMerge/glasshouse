import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { openapiApp } from "../../src/openapi.js";
import {
	createOtlpIngestHandler,
	resourceProjectIds,
} from "../../src/routes/otlp.js";
import { OtlpWireRequest } from "../../src/schemas/otlp.js";

const document = openapiApp.getOpenAPI31Document({
	openapi: "3.1.0",
	info: { title: "test", version: "1" },
});
const validateWire = new Ajv2020({
	strict: false,
	validateFormats: false,
}).compile({
	$ref: "#/components/schemas/OtlpWireRequest",
	components: document.components,
});

const tenant = {
	actorId: "11111111-1111-4111-8111-111111111111",
	organizationId: "22222222-2222-4222-8222-222222222222",
	projectId: "33333333-3333-4333-8333-333333333333",
};
const span = {
	traceId: "00112233445566778899aabbccddeeff",
	spanId: "0011223344556677",
	name: "null-regression",
	startTimeUnixNano: "1700000000000000000",
};
function payload(
	resource: object = {},
	scope: object = {},
	fields: object = {},
) {
	return {
		resourceSpans: [
			{
				...resource,
				scopeSpans: [{ ...scope, spans: [{ ...span, ...fields }] }],
			},
		],
	};
}
function request(body: unknown) {
	return new Request("http://localhost/v1/traces", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function captureExport(body: unknown, redactKeys?: string[]) {
	let admitted = false;
	const traces: unknown[] = [];
	const observations: unknown[] = [];
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) => {
			admitted = true;
			return callback({} as never);
		},
		approvedRedaction: async () =>
			redactKeys ? { mode: "none", keys: redactKeys } : null,
		defaultClient: () => ({}) as never,
		insertTraces: async (_client, rows) => {
			traces.push(...rows);
		},
		insertObservations: async (_client, rows) => {
			observations.push(...rows);
		},
		publishSync: () => undefined,
	});
	const response = await handler(request(body), tenant);
	return { status: response.status, admitted, traces, observations };
}

test("OTLP handler rejects nested scalar types rejected by its wire schemas", async () => {
	const body = payload(
		{},
		{},
		{
			attributes: [
				{
					key: "payload",
					value: { arrayValue: { values: [{ stringValue: 7 }] } },
				},
			],
		},
	);
	expect(OtlpWireRequest.safeParse(body).success).toBe(false);
	expect(validateWire(body)).toBe(false);
	const result = await captureExport(body);
	expect(result, JSON.stringify(result)).toEqual({
		status: 400,
		admitted: false,
		traces: [],
		observations: [],
	});
});

for (const value of [
	{ futureExtension: [null] },
	{ stringValue: null, futureExtension: [null] },
]) {
	test(`OTLP handler ignores extension-only AnyValue ${JSON.stringify(value)}`, async () => {
		const body = payload(
			{},
			{},
			{
				attributes: [{ key: "extension", value }],
			},
		);
		expect(OtlpWireRequest.safeParse(body).success).toBe(true);
		expect(validateWire(body)).toBe(true);
		const result = await captureExport(body);
		expect(result.status, JSON.stringify(result)).toBe(200);
		expect(result.observations).toHaveLength(1);
		const redacted = await captureExport(body, ["secret"]);
		expect(redacted.status).toBe(200);
		expect(redacted.observations).toHaveLength(1);
		expect(JSON.stringify(redacted.observations)).not.toContain(
			"futureExtension",
		);
	});
}

for (const [name, leaf, status] of [
	["below", { arrayValue: {} }, 200],
	["at", { arrayValue: { values: [] } }, 200],
	["above", { arrayValue: { values: [{}] } }, 400],
] as const) {
	test(`OTLP handler bounds known nesting ${name} depth 32`, async () => {
		let value: unknown = leaf;
		for (let i = 0; i < 7; i++) value = { arrayValue: { values: [value] } };
		const body = payload({}, {}, { attributes: [{ key: "payload", value }] });
		const result = await captureExport(body);
		expect(result.status).toBe(status);
		expect(result.admitted).toBe(status === 200);
		expect(result.observations).toHaveLength(status === 200 ? 1 : 0);
	});
}

test("OTLP handler accepts deeply nested unknown extensions without retaining them", async () => {
	const body = JSON.stringify(
		payload(
			{},
			{},
			{
				attributes: [
					{
						key: "payload",
						value: { stringValue: "also-drop", futureExtension: "PLACEHOLDER" },
					},
				],
			},
		),
	).replace(
		'"PLACEHOLDER"',
		'{"values":['.repeat(20_000) + '"never-retain"' + "]}".repeat(20_000),
	);
	const rows: unknown[] = [];
	const tokens: string[] = [];
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) =>
			callback({} as never),
		approvedRedaction: async () => ({ mode: "none", keys: ["secret"] }),
		defaultClient: () => ({}) as never,
		insertTraces: async (_client, _rows, token) => {
			tokens.push(token);
		},
		insertObservations: async (_client, values, token) => {
			rows.push(...values);
			tokens.push(token);
		},
		publishSync: () => undefined,
	});
	for (let i = 0; i < 2; i++) {
		const response = await handler(
			new Request("http://localhost/v1/traces", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			}),
			tenant,
		);
		expect(response.status).toBe(200);
	}
	expect(rows).toHaveLength(2);
	expect(JSON.stringify(rows)).not.toContain("never-retain");
	expect(JSON.stringify(rows)).not.toContain("also-drop");
	expect(tokens[0]).toBe(tokens[2]);
	expect(tokens[1]).toBe(tokens[3]);
});

test("OTLP handler ignores deeply nested extension data but redacts it fail closed", async () => {
	let extension: unknown = {
		key: "secret",
		value: { stringValue: "never-retain" },
	};
	for (let i = 0; i < 100; i++) extension = { values: [extension] };
	const body = payload(
		{},
		{},
		{
			attributes: [
				{
					key: "payload",
					value: { stringValue: "also-drop", futureExtension: extension },
				},
			],
		},
	);
	const result = await captureExport(body, ["secret"]);
	expect(result.status).toBe(200);
	expect(result.observations).toHaveLength(1);
	expect(JSON.stringify(result.observations)).not.toContain("never-retain");
	expect(JSON.stringify(result.observations)).not.toContain("also-drop");
});

for (const [levels, repeatedDepth] of [
	[7, 29],
	[8, 32],
	[9, 35],
] as const) {
	test(`OTLP handler rejects null repeated elements at normalization depth ${repeatedDepth}`, async () => {
		let value: unknown = null;
		for (let i = 0; i < levels; i++)
			value = { arrayValue: { values: [value] } };
		const body = payload({}, {}, { attributes: [{ key: "payload", value }] });
		expect(OtlpWireRequest.safeParse(body).success).toBe(false);
		expect(validateWire(body)).toBe(false);
		const result = await captureExport(body);
		expect(result, JSON.stringify(result)).toEqual({
			status: 400,
			admitted: false,
			traces: [],
			observations: [],
		});
	});
}

for (const [name, body] of [
	["request", { ...payload(), futureExtension: [null] }],
	["resource spans", payload({ futureExtension: [null] })],
	["resource", payload({ resource: { futureExtension: [null] } })],
	["scope spans", payload({}, { futureExtension: [null] })],
	["scope", payload({}, { scope: { futureExtension: [null] } })],
	["span", payload({}, {}, { futureExtension: [null] })],
	[
		"extension subtree",
		payload({}, {}, { futureExtension: { spans: [null] } }),
	],
	["inherited property name", payload({}, {}, { toString: [null] })],
	["status", payload({}, {}, { status: { futureExtension: [null] } })],
	["field from another message", payload({}, {}, { resourceSpans: [null] })],
] as const) {
	test(`OTLP JSON ignores unknown ${name} fields containing null arrays`, async () => {
		let stored: unknown;
		const handler = createOtlpIngestHandler({
			withActiveAuthorizedProjectLock: async (_tenant, callback) =>
				callback({} as never),
			approvedRedaction: async () => null,
			defaultClient: () => ({}) as never,
			insertTraces: async () => undefined,
			insertObservations: async (_client, rows) => {
				stored = rows;
			},
			publishSync: () => undefined,
		});
		const response = await handler(request(body), tenant);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({});
		expect(stored).toMatchObject([
			{
				observation_id: span.spanId,
				project_id: tenant.projectId,
				organization_id: tenant.organizationId,
			},
		]);
		expect(JSON.stringify(stored)).not.toContain("futureExtension");
		expect(OtlpWireRequest.safeParse(body).success).toBe(true);
		expect(validateWire(body), JSON.stringify(validateWire.errors)).toBe(true);
	});
}

for (const [name, body] of [
	["resource", payload({ resource: null })],
	[
		"resource attributes",
		payload({ resource: { attributes: null, droppedAttributesCount: null } }),
	],
	["scope", payload({}, { scope: null })],
	[
		"scope fields",
		payload({}, { scope: { name: null, version: null, attributes: null } }),
	],
	[
		"span fields",
		payload(
			{},
			{},
			{
				parentSpanId: null,
				kind: null,
				endTimeUnixNano: null,
				attributes: null,
				status: null,
				events: null,
				links: null,
				traceState: null,
			},
		),
	],
	["status fields", payload({}, {}, { status: { code: null, message: null } })],
	[
		"attribute value",
		payload({}, {}, { attributes: [{ key: "unset", value: null }] }),
	],
	[
		"AnyValue oneof",
		payload(
			{},
			{},
			{ attributes: [{ key: "unset", value: { stringValue: null } }] },
		),
	],
	[
		"all AnyValue alternatives",
		payload(
			{},
			{},
			{
				attributes: [
					{
						key: "unset",
						value: {
							stringValue: null,
							boolValue: null,
							intValue: null,
							doubleValue: null,
							bytesValue: null,
							arrayValue: null,
							kvlistValue: null,
						},
					},
				],
			},
		),
	],
	[
		"collection values",
		payload(
			{},
			{},
			{
				attributes: [
					{ key: "array", value: { arrayValue: { values: null } } },
					{ key: "kvlist", value: { kvlistValue: { values: null } } },
				],
			},
		),
	],
	[
		"nested collection",
		payload(
			{},
			{},
			{
				attributes: [
					{
						key: "nested",
						value: {
							arrayValue: { values: [{ kvlistValue: { values: null } }] },
						},
					},
				],
			},
		),
	],
] as const) {
	test(`OTLP JSON treats null ${name} as unset while retaining the supported span`, async () => {
		let stored: unknown;
		const handler = createOtlpIngestHandler({
			withActiveAuthorizedProjectLock: async (_tenant, callback) =>
				callback({} as never),
			approvedRedaction: async () => null,
			defaultClient: () => ({}) as never,
			insertTraces: async () => undefined,
			insertObservations: async (_client, rows) => {
				stored = rows;
			},
			publishSync: () => undefined,
		});
		const response = await handler(request(body), tenant);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({});
		expect(stored).toMatchObject([
			{
				observation_id: span.spanId,
				project_id: tenant.projectId,
				organization_id: tenant.organizationId,
				parent_observation_id: null,
			},
		]);
		expect(JSON.stringify(stored)).not.toContain('"value":null');
		expect(OtlpWireRequest.safeParse(body).success).toBe(true);
		expect(validateWire(body), JSON.stringify(validateWire.errors)).toBe(true);
	});
}

test("OTLP JSON preserves non-null falsy AnyValues alongside unset alternatives", async () => {
	let attributes: unknown;
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) =>
			callback({} as never),
		approvedRedaction: async () => null,
		defaultClient: () => ({}) as never,
		insertTraces: async () => undefined,
		insertObservations: async (_client, rows) => {
			attributes = rows[0]?.metadata.attributes;
		},
		publishSync: () => undefined,
	});
	const expected = [
		{ key: "bool", value: { boolValue: false } },
		{ key: "integer", value: { intValue: "0" } },
		{ key: "double", value: { doubleValue: 0 } },
		{ key: "text", value: { stringValue: "" } },
		{ key: "bytes", value: { bytesValue: "" } },
	];
	const body = payload(
		{},
		{},
		{
			attributes: expected.map((attribute) => ({
				...attribute,
				value: { ...attribute.value, kvlistValue: null },
			})),
		},
	);
	expect((await handler(request(body), tenant)).status).toBe(200);
	expect(attributes).toEqual(expected);
});

test("OTLP JSON null normalization preserves nested redaction and Project provenance", async () => {
	let retained = "";
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) =>
			callback({} as never),
		approvedRedaction: async () => ({ mode: "none", keys: ["secret"] }),
		defaultClient: () => ({}) as never,
		insertTraces: async () => undefined,
		insertObservations: async (_client, rows) => {
			retained = JSON.stringify(rows);
		},
		publishSync: () => undefined,
	});
	const body = payload(
		{
			resource: {
				attributes: [
					{
						key: "glasshouse.project.id",
						value: { stringValue: tenant.projectId },
					},
				],
			},
		},
		{},
		{
			attributes: [
				{
					key: "nested",
					value: {
						arrayValue: {
							values: [
								{
									kvlistValue: {
										values: [
											{
												key: "secret",
												value: { stringValue: "never-retain", boolValue: null },
											},
											{
												key: "kept",
												value: { stringValue: "safe", intValue: null },
											},
										],
									},
								},
							],
						},
					},
				},
			],
		},
	);
	expect(await resourceProjectIds(request(body))).toEqual(
		new Set([tenant.projectId]),
	);
	expect((await handler(request(body), tenant)).status).toBe(200);
	expect(retained).toContain("safe");
	expect(retained).not.toContain("never-retain");
});

test("OTLP JSON null normalization does not repair unknown nested attribute fields before redaction", async () => {
	let retained = "";
	const handler = createOtlpIngestHandler({
		withActiveAuthorizedProjectLock: async (_tenant, callback) =>
			callback({} as never),
		approvedRedaction: async () => ({ mode: "none", keys: ["secret"] }),
		defaultClient: () => ({}) as never,
		insertTraces: async () => undefined,
		insertObservations: async (_client, rows) => {
			retained = JSON.stringify(rows);
		},
		publishSync: () => undefined,
	});
	const body = payload(
		{},
		{},
		{
			attributes: [
				{
					key: "nested",
					value: {
						arrayValue: {
							values: [
								{ stringValue: "drop-unknown-anyvalue", unknown: [null] },
								{ stringValue: "drop-unknown-null-anyvalue", unknown: null },
								{
									kvlistValue: {
										unknown: null,
										values: [
											{
												key: "safe",
												value: { stringValue: "drop-unknown-collection" },
											},
										],
									},
								},
								{
									kvlistValue: {
										values: [
											{
												key: "safe",
												unknown: null,
												value: { stringValue: "drop-unknown-attribute" },
											},
										],
									},
								},
								{ stringValue: "retained-safe" },
							],
						},
					},
				},
			],
		},
	);
	expect((await handler(request(body), tenant)).status).toBe(200);
	expect(retained).toContain("retained-safe");
	expect(retained).not.toContain("drop-unknown");
});

const invalidBodies = [
	["resource element", { resourceSpans: [null] }],
	["scope element", { resourceSpans: [{ scopeSpans: [null] }] }],
	["span element", { resourceSpans: [{ scopeSpans: [{ spans: [null] }] }] }],
	["attribute element", payload({}, {}, { attributes: [null] })],
	["event element", payload({}, {}, { events: [null] })],
	["link element", payload({}, {}, { links: [null] })],
	[
		"event attribute element",
		payload({}, {}, { events: [{ attributes: [null] }] }),
	],
	[
		"link attribute element",
		payload({}, {}, { links: [{ attributes: [null] }] }),
	],
	[
		"nested AnyValue element",
		payload(
			{},
			{},
			{
				attributes: [
					{ key: "nested", value: { arrayValue: { values: [null] } } },
				],
			},
		),
	],
	[
		"deeply nested AnyValue element",
		payload(
			{},
			{},
			{
				attributes: [
					{
						key: "nested",
						value: {
							arrayValue: {
								values: [
									{
										kvlistValue: {
											values: [
												{
													key: "deeper",
													value: { arrayValue: { values: [null] } },
												},
											],
										},
									},
								],
							},
						},
					},
				],
			},
		),
	],
	[
		"nested KeyValue element",
		payload(
			{},
			{},
			{
				attributes: [
					{ key: "nested", value: { kvlistValue: { values: [null] } } },
				],
			},
		),
	],
	["required trace ID", payload({}, {}, { traceId: null })],
	["required name", payload({}, {}, { name: null })],
	["required start time", payload({}, {}, { startTimeUnixNano: null })],
	["malformed resource", payload({ resource: 7 })],
	["malformed status", payload({}, {}, { status: false })],
	["malformed scalar", payload({}, {}, { kind: "invalid" })],
	["fractional end time", payload({}, {}, { endTimeUnixNano: 0.5 })],
] as const;

for (const [name, body] of invalidBodies) {
	test(`OTLP JSON still rejects null or malformed ${name} before authorization or persistence`, async () => {
		let admitted = false;
		const handler = createOtlpIngestHandler({
			withActiveAuthorizedProjectLock: async () => {
				admitted = true;
				throw new Error("must not reach storage");
			},
		});
		const response = await handler(request(body), tenant);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			message: "Invalid trace export request",
		});
		expect(admitted).toBe(false);
	});
	test(`OTLP wire Zod schema rejects null or malformed ${name}`, () => {
		expect(OtlpWireRequest.safeParse(body).success).toBe(false);
	});
	test(`OTLP wire OpenAPI/AJV schema rejects null or malformed ${name}`, () => {
		expect(validateWire(body), JSON.stringify(validateWire.errors)).toBe(false);
	});
}
