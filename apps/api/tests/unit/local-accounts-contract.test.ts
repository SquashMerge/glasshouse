import { expect, test } from "bun:test";
import {
	PUBLIC_API_ROUTES,
	ownsAuthenticationFence,
} from "../../src/middleware/auth";
import { openapiApp } from "../../src/openapi";

test("management operations are protected and cookie writes require CSRF", () => {
	const document = openapiApp.getOpenAPI31Document({
		openapi: "3.1.0",
		info: { title: "Account contract", version: "test" },
	});
	for (const [method, path] of [
		["get", "/v1/admin/local-accounts"],
		["post", "/v1/admin/local-accounts"],
		["put", "/v1/admin/local-accounts/{actorId}/status"],
		["post", "/v1/admin/local-accounts/{actorId}/reset"],
		["delete", "/v1/admin/local-enrollments/{enrollmentId}"],
	] as const) {
		expect(PUBLIC_API_ROUTES.has(`${method.toUpperCase()} ${path}`)).toBe(
			false,
		);
		expect(document.paths?.[path]?.[method]?.security).toEqual([
			method === "get"
				? { sessionCookie: [] }
				: { sessionCookie: [], csrfHeader: [] },
			{ basicAuth: [] },
		]);
	}
	const schemas = document.components?.schemas as Record<
		string,
		{ properties?: Record<string, unknown> }
	>;
	expect(Object.keys(schemas.LocalAccount!.properties!).sort()).toEqual([
		"actor_id",
		"enrollments",
		"organization_role",
		"project_grants",
		"status",
		"username",
	]);
	expect(Object.keys(schemas.EnrollmentCode!.properties!).sort()).toEqual([
		"actor_id",
		"code",
		"enrollment_id",
	]);
});

test("transaction-owned auth fences are method exact and do not add public routes", () => {
	for (const [method, path] of [
		["POST", "/v1/admin/local-accounts"],
		["PUT", "/v1/admin/local-accounts/test/status"],
		["POST", "/v1/admin/local-accounts/test/reset"],
		["DELETE", "/v1/admin/local-enrollments/test"],
		["PUT", "/v1/admin/actors/test/role"],
	] as const) {
		expect(ownsAuthenticationFence(method, path)).toBe(true);
		expect(ownsAuthenticationFence("GET", path)).toBe(false);
		expect(ownsAuthenticationFence(method, `${path}/extra`)).toBe(false);
		expect(PUBLIC_API_ROUTES.has(`${method} ${path}`)).toBe(false);
	}
});
