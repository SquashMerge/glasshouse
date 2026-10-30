import { describe, expect, it } from "bun:test";
import { openapiApp } from "../../src/openapi";
import {
	acceptInvitationRoute,
	changePasswordRoute,
	setupRoute,
} from "../../src/routes/auth";

function requestSchema(route: {
	request?: {
		body?: {
			content: Record<
				string,
				{ schema: { safeParse: (input: unknown) => { success: boolean } } }
			>;
		};
	};
}) {
	return route.request?.body?.content["application/json"]?.schema;
}

describe("password-setting API schemas", () => {
	it("requires the new-password policy for setup, enrollment and password changes", () => {
		const setup = requestSchema(setupRoute);
		const enrollment = requestSchema(acceptInvitationRoute);
		const change = requestSchema(changePasswordRoute);
		const shortSetup = {
			username: "test.admin",
			password: "too-short",
			token: "x".repeat(43),
		};
		const shortEnrollment = { password: "too-short", token: "x".repeat(43) };
		const shortChange = {
			current_password: "legacy",
			new_password: "too-short",
		};

		expect(setup?.safeParse(shortSetup).success).toBe(false);
		expect(enrollment?.safeParse(shortEnrollment).success).toBe(false);
		expect(change?.safeParse(shortChange).success).toBe(false);
	});

	it("still accepts a legacy short password for current-password verification", () => {
		const change = requestSchema(changePasswordRoute);
		expect(
			change?.safeParse({
				current_password: "legacy",
				new_password: "a-valid-new-password",
			}).success,
		).toBe(true);
	});

	it("publishes the new-password minimum as a machine-readable OpenAPI constraint", async () => {
		const response = await openapiApp.request("/openapi.json");
		const document = await response.json();
		const routes = [
			"/v1/auth/setup",
			"/v1/auth/invitations/accept",
			"/v1/auth/password",
		];

		for (const path of routes) {
			const passwordSchema =
				document.paths[path].post.requestBody.content["application/json"].schema
					.properties.password ??
				document.paths[path].post.requestBody.content["application/json"].schema
					.properties.new_password;
			expect(passwordSchema.minLength).toBe(12);
		}
	});
});
