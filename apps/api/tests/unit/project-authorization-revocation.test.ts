import { expect, test } from "bun:test";
import { lockActiveAuthorizedProject } from "../../src/db/project-authorization";

const authorization = {
	organization_id: "11111111-1111-4111-8111-111111111111",
	actor_id: "22222222-2222-4222-8222-222222222222",
	operation: "product_write" as const,
};

test("takes the project fence before actor membership locks and policy evaluation", async () => {
	const calls: string[] = [];
	const responses = [
		{ rows: [{ id: "project" }] },
		{ rows: [{ actor_subject: "member" }] },
		{ rows: [{ actor_subject: "member" }] },
		{ rows: [{ allowed: false }] },
	];
	const client = {
		query: async (statement: string) => {
			calls.push(statement);
			return responses.shift() ?? { rows: [] };
		},
	};

	await expect(
		lockActiveAuthorizedProject(client as never, "project", authorization),
	).resolves.toBe(false);
	expect(calls).toHaveLength(4);
	expect(calls[0]).toContain("p.status = ANY($5::text[])");
	expect(calls[0]).toContain("FOR UPDATE");
	expect(calls[0]).not.toContain("authorization_allows_project");
	expect(calls[1]).toContain("organization_memberships");
	expect(calls[1]).toContain("FOR UPDATE");
	expect(calls[2]).toContain("project_memberships");
	expect(calls[2]).toContain("FOR UPDATE");
	expect(calls[3]).toContain("authorization_allows_project");
});
