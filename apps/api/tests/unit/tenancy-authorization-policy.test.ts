import { expect, test } from "bun:test";
import {
	assertTenantProjectAccess,
	resolveAuthorizedProjectScope,
	TenantScopeError,
} from "../../src/tenancy";

const tenant = {
	actor: "reader",
	actorId: "11111111-1111-4111-8111-111111111111",
	organizationId: "22222222-2222-4222-8222-222222222222",
};
const projectId = "33333333-3333-4333-8333-333333333333";

test("uses the centralized database policy decision for strict project access", async () => {
	let statement = "";
	const scope = await resolveAuthorizedProjectScope(
		{
			query: async (sql: string) => {
				statement = sql;
				return {
					rows: [
						{
							effective_role: "read_only",
							enforcement: "strict",
							project_status: "active",
							allowed: true,
						},
					],
				};
			},
		} as never,
		tenant,
		projectId,
		"product_read",
	);

	expect(statement).toContain("authorization_effective_project_role");
	expect(statement).toContain("authorization_allows_project");
	expect(scope.projectRole).toBe("read_only");
	expect(scope.enforcement).toBe("strict");
});

test("rejects a strict Read-only write before persistence", async () => {
	await expect(
		assertTenantProjectAccess(
			{
				query: async () => ({
					rows: [
						{
							effective_role: "read_only",
							enforcement: "strict",
							project_status: "active",
							allowed: false,
						},
					],
				}),
			} as never,
			tenant,
			projectId,
			"product_write",
		),
	).rejects.toBeInstanceOf(TenantScopeError);
});
