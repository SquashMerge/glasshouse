import { describe, expect, it } from "bun:test";
import { openapiApp } from "../../src/openapi";
import {
	acceptInvitationRoute,
	changePasswordRoute,
	loginRoute,
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

describe("local password policy API schemas", () => {
	it("requires the policy for login, setup, enrollment and password changes", () => {
		const login = requestSchema(loginRoute);
		const setup = requestSchema(setupRoute);
		const enrollment = requestSchema(acceptInvitationRoute);
		const change = requestSchema(changePasswordRoute);
		const validPassword = "a-valid-new-password";

		expect(
			login?.safeParse({ username: "test.admin", password: "too-short" })
				.success,
		).toBe(false);
		expect(
			login?.safeParse({ username: "test.admin", password: validPassword })
				.success,
		).toBe(true);
		expect(
			setup?.safeParse({
				username: "test.admin",
				password: "too-short",
				token: "x".repeat(43),
			}).success,
		).toBe(false);
		expect(
			enrollment?.safeParse({ password: "too-short", token: "x".repeat(43) })
				.success,
		).toBe(false);
		expect(
			change?.safeParse({
				current_password: "too-short",
				new_password: validPassword,
			}).success,
		).toBe(false);
		expect(
			change?.safeParse({
				current_password: validPassword,
				new_password: "too-short",
			}).success,
		).toBe(false);
	});

	it("publishes the minimum on every local password field in OpenAPI", async () => {
		const response = await openapiApp.request("/openapi.json");
		const document = await response.json();
		const fields = [
			{ path: "/v1/auth/login", property: "password", union: true },
			{ path: "/v1/auth/setup", property: "password" },
			{ path: "/v1/auth/invitations/accept", property: "password" },
			{ path: "/v1/auth/password", property: "current_password" },
			{ path: "/v1/auth/password", property: "new_password" },
		];

		for (const { path, property, union } of fields) {
			const requestBody =
				document.paths[path].post.requestBody.content["application/json"]
					.schema;
			const bodySchema = union ? requestBody.anyOf[0] : requestBody;
			expect(bodySchema.properties[property].minLength).toBe(12);
		}
	});
});
