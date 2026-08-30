import { describe, it, expect, beforeAll, mock } from "bun:test";

const USER = "astraea";
const PASS = "secret";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
process.env.UI_USERNAME = USER;
process.env.UI_PASSWORD = PASS;

const { createApiApp } = await import("../../src/index");
const { createHealthHandler } = await import("../../src/routes/health");
const { createOtlpIngestHandler } = await import("../../src/routes/otlp");
const { TenantScopeError } = await import("../../src/tenancy");

const insertTraces = mock(() => Promise.resolve());
const insertObservations = mock(() => Promise.resolve());
const defaultClient = mock(() => ({}));
const withActiveAuthorizedProjectLock = async <T>(
	_tenant: unknown,
	callback: () => Promise<T>,
) => callback();
const assertTenantProjectAccess = mock(async () => undefined);
const resolveTenantProject = mock(async () => TEST_SCOPE);
const TEST_TENANT = {
	actor: USER,
	organizationId: "00000000-0000-4000-8000-000000000001",
};
const TEST_SCOPE = {
	...TEST_TENANT,
	projectId: "00000000-0000-4000-8000-000000000002",
};
const apiApp = createApiApp({
	handleHealth: createHealthHandler({
		chPing: async () => "up",
		pgPing: async () => "up",
		valkeyPing: async () => "up",
	}),
	handleOtlpIngest: createOtlpIngestHandler({
		defaultClient,
		insertObservations,
		insertTraces,
		publishSync: () => undefined,
		approvedRedaction: async () => null,
		withActiveAuthorizedProjectLock,
	}),
	assertTenantProjectAccess,
	resolveTenantProject,
});

beforeAll(() => {
	process.env.UI_USERNAME = USER;
	process.env.UI_PASSWORD = PASS;
});

describe("API integration: health + openapi", () => {
	it("GET /health returns 200 without auth", async () => {
		const res = await apiApp.fetch(new Request("http://x/health"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string };
		expect(body.status).toBe("ok");
	});

	it("GET /openapi.json returns 200 without auth", async () => {
		const res = await apiApp.fetch(new Request("http://x/openapi.json"));
		expect(res.status).toBe(200);
		const document = (await res.json()) as {
			components?: {
				securitySchemes?: { basicAuth?: { type?: string; scheme?: string } };
			};
			paths?: Record<string, { post?: unknown }>;
		};
		expect(document.components?.securitySchemes?.basicAuth).toEqual({
			type: "http",
			scheme: "basic",
		});
		expect(document.paths?.["/v1/otel/v1/traces"]?.post).toBeDefined();
	});

	it("production OpenAPI excludes legacy subject-keyed membership operations", async () => {
		const res = await apiApp.fetch(new Request("http://x/openapi.json"));
		expect(res.status).toBe(200);
		const document = (await res.json()) as {
			paths?: Record<string, Record<string, unknown>>;
		};
		const legacyOperations = [
			["/v1/projects/{id}/members", "get"],
			["/v1/projects/{id}/members/{actor}", "put"],
			["/v1/projects/{id}/members/{actor}", "delete"],
			["/v1/organization/members/{actor}", "put"],
			["/v1/organization/members", "get"],
			["/v1/organization/members/{actor}", "delete"],
		] as const;
		for (const [path, method] of legacyOperations)
			expect(document.paths?.[path]?.[method]).toBeUndefined();

		const durableOperations = [
			["/v1/admin/actors", "get"],
			["/v1/admin/actors/{actorId}/role", "put"],
			["/v1/admin/projects/{projectId}/grants", "get"],
			["/v1/admin/projects/{projectId}/grants/{actorId}", "put"],
			["/v1/admin/projects/{projectId}/grants/{actorId}", "delete"],
		] as const;
		for (const [path, method] of durableOperations)
			expect(document.paths?.[path]?.[method]).toBeDefined();
	});

	it("GET /reference returns 200 without auth", async () => {
		const res = await apiApp.fetch(new Request("http://x/reference"));
		expect(res.status).toBe(200);
	});

	it("Every response includes the security headers", async () => {
		const res = await apiApp.fetch(new Request("http://x/health"));
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
	});
});

describe("API integration: auth gate", () => {
	it("GET /v1/traces without auth returns 401 with WWW-Authenticate", async () => {
		const res = await apiApp.fetch(new Request("http://x/v1/traces"));
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toMatch(
			/^Basic realm="astraea"/,
		);
	});

	it("POST /v1/auth/login with valid creds returns 200 { ok: true }", async () => {
		const res = await apiApp.fetch(
			new Request("http://x/v1/auth/login", {
				method: "POST",
				headers: { authorization: AUTH, "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
		expect(assertTenantProjectAccess).not.toHaveBeenCalled();
	});

	it("POST /v1/auth/login with bad creds returns 401", async () => {
		const res = await apiApp.fetch(
			new Request("http://x/v1/auth/login", {
				method: "POST",
				headers: {
					authorization:
						"Basic " + Buffer.from("wrong:wrong").toString("base64"),
				},
				body: "{}",
			}),
		);
		expect(res.status).toBe(401);
	});

	it("rejects a project selector outside the authenticated organization before the route executes", async () => {
		const foreignProject = "00000000-0000-4000-8000-000000000099";
		assertTenantProjectAccess.mockImplementationOnce(async () => {
			throw new TenantScopeError(
				"Project is not available to this organization",
			);
		});
		const res = await apiApp.fetch(
			new Request(`http://x/v1/traces/events?project_id=${foreignProject}`, {
				headers: { authorization: AUTH },
			}),
		);
		expect(res.status).toBe(404);
		expect(assertTenantProjectAccess.mock.calls.at(-1)?.[2]).toBe(
			foreignProject,
		);
	});

	it("rejects unavailable project selectors on observability REST lists", async () => {
		const foreignProject = "00000000-0000-4000-8000-000000000099";
		for (const path of ["/v1/traces", "/v1/observations"]) {
			assertTenantProjectAccess.mockImplementationOnce(async () => {
				throw new TenantScopeError(
					"Project is not available to this organization",
				);
			});
			const res = await apiApp.fetch(
				new Request(`http://x${path}?project_id=${foreignProject}`, {
					headers: new Headers([["authorization", AUTH]]),
				}),
			);
			expect(res.status).toBe(404);
		}
	});

	it("rejects a query/body project mismatch before a body-scoped route executes", async () => {
		const authorizedProject = "00000000-0000-4000-8000-000000000002";
		const foreignProject = "00000000-0000-4000-8000-000000000099";
		assertTenantProjectAccess.mockClear();
		assertTenantProjectAccess.mockImplementation(
			async (_pool, _tenant, projectId) => {
				if (projectId === foreignProject)
					throw new TenantScopeError(
						"Project is not available to this organization",
					);
			},
		);

		const res = await apiApp.fetch(
			new Request(`http://x/v1/datasets?project_id=${authorizedProject}`, {
				method: "POST",
				headers: new Headers([
					["authorization", AUTH],
					["content-type", "application/json"],
				]),
				body: JSON.stringify({
					project_id: foreignProject,
					name: "must-not-write",
				}),
			}),
		);

		expect(res.status).toBe(404);
		expect(assertTenantProjectAccess).not.toHaveBeenCalled();
	});

	it("rejects a query/body project mismatch with a mixed-case JSON media type", async () => {
		const authorizedProject = "00000000-0000-4000-8000-000000000002";
		const foreignProject = "00000000-0000-4000-8000-000000000099";
		assertTenantProjectAccess.mockClear();

		const res = await apiApp.fetch(
			new Request(`http://x/v1/datasets?project_id=${authorizedProject}`, {
				method: "POST",
				headers: new Headers([
					["authorization", AUTH],
					["content-type", "Application/JSON; Charset=UTF-8"],
				]),
				body: JSON.stringify({
					project_id: foreignProject,
					name: "must-not-write",
				}),
			}),
		);

		expect(res.status).toBe(404);
		expect(assertTenantProjectAccess).not.toHaveBeenCalled();
	});
});

describe("API integration: OTLP ingest", () => {
	const HEX32 = "00112233445566778899aabbccddeeff";
	const HEX16 = "0011223344556677";
	const NOW_NS = 1_700_000_000_000_000_000;

	function validOtlp(
		extra: Record<string, unknown> = {},
		resourceAttributes: Array<Record<string, unknown>> = [],
	) {
		return {
			resource_spans: [
				{
					resource: { attributes: resourceAttributes },
					scope_spans: [
						{
							scope: { name: "test", version: "1.0.0" },
							spans: [
								{
									trace_id: HEX32,
									span_id: HEX16,
									name: "test-span",
									start_time_unix_nano: String(NOW_NS),
									attributes: [
										{ key: "gen_ai.system", value: { stringValue: "openai" } },
									],
									...extra,
								},
							],
						},
					],
				},
			],
		};
	}

	function otlpHeaders(projectId = TEST_SCOPE.projectId) {
		return {
			authorization: AUTH,
			"content-type": "application/json",
			"x-astraea-project-id": projectId,
		};
	}

	it("routes valid headed OTLP through its dedicated membership resolver", async () => {
		insertTraces.mockClear();
		insertObservations.mockClear();
		assertTenantProjectAccess.mockClear();
		resolveTenantProject.mockClear();

		const res = await apiApp.fetch(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: otlpHeaders(),
				body: JSON.stringify(validOtlp()),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { partial_success: unknown };
		expect(body.partial_success).toEqual({});
		expect(insertTraces).toHaveBeenCalledTimes(1);
		expect(insertObservations).toHaveBeenCalledTimes(1);
		expect(
			(insertTraces.mock.calls[0]?.[1] as Array<{ project_id: string }>)[0]
				?.project_id,
		).toBe(TEST_SCOPE.projectId);
		expect(
			(
				insertObservations.mock.calls[0]?.[1] as Array<{ project_id: string }>
			)[0]?.project_id,
		).toBe(TEST_SCOPE.projectId);
		expect(resolveTenantProject).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				...TEST_TENANT,
				actorId: expect.any(String),
			}),
			TEST_SCOPE.projectId,
			"ingest",
		);
		expect(assertTenantProjectAccess).not.toHaveBeenCalled();
	});

	it("uses the authorized OTLP header project when resource provenance is absent", async () => {
		insertTraces.mockClear();
		insertObservations.mockClear();
		const res = await apiApp.fetch(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: otlpHeaders(),
				body: JSON.stringify(validOtlp()),
			}),
		);
		expect(res.status).toBe(200);
		expect(
			(insertTraces.mock.calls[0]?.[1] as Array<{ project_id: string }>)[0]
				?.project_id,
		).toBe(TEST_SCOPE.projectId);
		expect(
			(
				insertObservations.mock.calls[0]?.[1] as Array<{ project_id: string }>
			)[0]?.project_id,
		).toBe(TEST_SCOPE.projectId);
	});

	it("returns 400 on malformed JSON", async () => {
		const res = await apiApp.fetch(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: otlpHeaders(),
				body: "not json",
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("BAD_REQUEST");
	});

	it("returns 400 on Zod validation failure", async () => {
		const res = await apiApp.fetch(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: otlpHeaders(),
				body: JSON.stringify({ resource_spans: [] }),
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("BAD_REQUEST");
	});

	it("returns 401 without auth", async () => {
		const res = await apiApp.fetch(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(validOtlp()),
			}),
		);
		expect(res.status).toBe(401);
	});

	it("rejects a missing or malformed OTLP project header before persistence", async () => {
		for (const header of [undefined, "not-a-uuid"]) {
			insertTraces.mockClear();
			insertObservations.mockClear();
			const headers = new Headers({
				authorization: AUTH,
				"content-type": "application/json",
			});
			if (header) headers.set("x-astraea-project-id", header);

			const res = await apiApp.fetch(
				new Request("http://x/v1/otel/v1/traces", {
					method: "POST",
					headers,
					body: JSON.stringify(validOtlp()),
				}),
			);
			expect(res.status).toBe(404);
			expect(insertTraces).not.toHaveBeenCalled();
			expect(insertObservations).not.toHaveBeenCalled();
		}
	});

	it("rejects an unavailable OTLP header project before persistence", async () => {
		const foreignProject = "00000000-0000-4000-8000-000000000099";
		insertTraces.mockClear();
		insertObservations.mockClear();
		resolveTenantProject.mockImplementationOnce(async () => {
			throw new TenantScopeError(
				"Project is not available to this organization",
			);
		});

		const res = await apiApp.fetch(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: otlpHeaders(foreignProject),
				body: JSON.stringify(validOtlp()),
			}),
		);

		expect(res.status).toBe(404);
		expect(resolveTenantProject.mock.calls.at(-1)?.[2]).toBe(foreignProject);
		expect(insertTraces).not.toHaveBeenCalled();
		expect(insertObservations).not.toHaveBeenCalled();
	});

	it("rejects a resource project that disagrees with the OTLP project header", async () => {
		const resourceProject = "00000000-0000-4000-8000-000000000003";
		insertTraces.mockClear();
		insertObservations.mockClear();

		const res = await apiApp.fetch(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: otlpHeaders(),
				body: JSON.stringify(
					validOtlp({}, [
						{
							key: "astraea.project.id",
							value: { stringValue: resourceProject },
						},
					]),
				),
			}),
		);

		expect(res.status).toBe(404);
		expect(insertTraces).not.toHaveBeenCalled();
		expect(insertObservations).not.toHaveBeenCalled();
	});

	it("applies ASTRAEA_REDACT_INPUT=true when ingesting", async () => {
		process.env.ASTRAEA_REDACT_INPUT = "true";
		insertTraces.mockClear();
		insertObservations.mockClear();
		try {
			const res = await apiApp.fetch(
				new Request("http://x/v1/otel/v1/traces", {
					method: "POST",
					headers: otlpHeaders(),
					body: JSON.stringify(
						validOtlp({
							attributes: [
								{
									key: "gen_ai.prompt.0.content",
									value: { stringValue: "SECRET_PROMPT" },
								},
							],
						}),
					),
				}),
			);
			expect(res.status).toBe(200);
			const traces = insertTraces.mock.calls[0]?.[1] as Array<{
				input_text: string;
			}>;
			expect(traces[0]?.input_text).toBe("[REDACTED]");
		} finally {
			delete process.env.ASTRAEA_REDACT_INPUT;
		}
	});

	it("returns generic 500 on ClickHouse insert failure (no internals leaked)", async () => {
		insertTraces.mockImplementationOnce(() =>
			Promise.reject(new Error("Connection refused: 10.0.0.1:8123")),
		);
		const res = await apiApp.fetch(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: otlpHeaders(),
				body: JSON.stringify(validOtlp()),
			}),
		);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("INTERNAL");
		expect(body.message).not.toContain("Connection refused");
		expect(body.message).not.toContain("10.0.0.1");
	});
});

describe("API integration: body size limit", () => {
	it("rejects oversized bodies with 413", async () => {
		const big = "x".repeat(2_000_000);
		const res = await apiApp.fetch(
			new Request("http://x/v1/otel/v1/traces", {
				method: "POST",
				headers: {
					authorization: AUTH,
					"content-type": "application/json",
					"content-length": String(big.length),
				},
				body: big,
			}),
		);
		expect(res.status).toBe(413);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("PAYLOAD_TOO_LARGE");
	});
});
