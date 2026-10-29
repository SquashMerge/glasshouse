import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { authenticationMiddleware } from "../../src/middleware/auth.js";
import { openapiApp } from "../../src/openapi.js";
import { trustedTenant } from "../../src/tenancy.js";

const secret = `gh_ing_${"b".repeat(43)}`;
const digest = createHash("sha256").update(secret, "utf8").digest("hex");
const credentialLookup: string[] = [];
const pool = {
	async query(sql: string) {
		if (sql.includes("FROM project_otlp_credentials WHERE secret_digest")) {
			credentialLookup.push(sql);
			return {
				rows: [
					{
						id: "11111111-1111-4111-8111-111111111111",
						organization_id: "22222222-2222-4222-8222-222222222222",
						project_id: "33333333-3333-4333-8333-333333333333",
						created_by_actor_id: "44444444-4444-4444-8444-444444444444",
					},
				],
				rowCount: 1,
			};
		}
		return { rows: [], rowCount: 0 };
	},
	async connect() {
		return {
			async query() {
				return { rows: [], rowCount: 0 };
			},
			release() {},
		};
	},
};

function app() {
	const original = process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
	process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = JSON.stringify([
		{
			username: "otlp-auth-test",
			password: randomBytes(32).toString("base64url"),
			organization_id: "22222222-2222-4222-8222-222222222222",
		},
	]);
	const authentication = authenticationMiddleware(
		() => pool as never,
		() => pool as never,
	);
	if (original === undefined)
		delete process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
	else process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = original;
	const api = new Hono();
	api.use("*", authentication);
	api.post("/v1/otel/v1/traces", (c) => {
		const tenant = trustedTenant(c);
		return c.json({
			organizationId: tenant.organizationId,
			credentialId: tenant.ingestCredential?.id,
			projectId: tenant.ingestCredential?.projectId,
			digest: tenant.ingestCredential?.digest,
		});
	});
	api.get("/v1/otel/v1/traces", (c) => c.json({ accepted: true }));
	api.get("/v1/traces", (c) => c.json({ accepted: true }));
	return api;
}

test("bearer ingestion credentials authenticate only the OTLP trace POST and never expose the secret", async () => {
	credentialLookup.length = 0;
	const api = app();
	const accepted = await api.request("/v1/otel/v1/traces", {
		method: "POST",
		headers: { authorization: `Bearer ${secret}` },
	});
	expect(accepted.status).toBe(200);
	expect(await accepted.json()).toEqual({
		organizationId: "22222222-2222-4222-8222-222222222222",
		credentialId: "11111111-1111-4111-8111-111111111111",
		projectId: "33333333-3333-4333-8333-333333333333",
		digest,
	});

	const wrongMethod = await api.request("/v1/otel/v1/traces", {
		headers: { authorization: `Bearer ${secret}` },
	});
	const dashboard = await api.request("/v1/traces", {
		headers: { authorization: `Bearer ${secret}` },
	});
	expect(wrongMethod.status).toBe(401);
	expect(dashboard.status).toBe(401);
	expect(credentialLookup).toHaveLength(1);
});

test("accepts case-insensitive HTTP Bearer authentication schemes", async () => {
	credentialLookup.length = 0;
	const response = await app().request("/v1/otel/v1/traces", {
		method: "POST",
		headers: { authorization: `bearer ${secret}` },
	});

	expect(response.status).toBe(200);
});

test("documents the credential auth choices on the OTLP trace operation", () => {
	const document = openapiApp.getOpenAPI31Document({
		openapi: "3.1.0",
		info: { title: "OTLP auth contract", version: "test" },
	});

	expect(document.components?.securitySchemes?.bearerAuth).toEqual({
		type: "http",
		scheme: "bearer",
		description:
			"Project-scoped OTLP ingest credential, accepted only for POST /v1/otel/v1/traces.",
	});
	expect(document.paths?.["/v1/otel/v1/traces"]?.post?.security).toEqual([
		{ sessionCookie: [], csrfHeader: [] },
		{ basicAuth: [] },
		{ bearerAuth: [] },
	]);
});
