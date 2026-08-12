import { expect, test } from "bun:test";
import { lockActiveAuthorizedProject } from "../../src/db/project-authorization";

const authorization = {
	organization_id: "11111111-1111-4111-8111-111111111111",
	actor_id: "22222222-2222-4222-8222-222222222222",
	operation: "product_write" as const,
};

test("takes actor membership locks before the project fence and policy evaluation", async () => {
	const calls: string[] = [];
	const client = {
		query: async (statement: string) => {
			calls.push(statement);
			if (statement.includes("organization_memberships"))
				return { rows: [{ actor_subject: "member" }] };
			if (statement.includes("project_memberships"))
				return { rows: [{ actor_subject: "member" }] };
			if (statement.includes("FROM projects p"))
				return { rows: [{ id: "project" }] };
			return { rows: [{ allowed: false }] };
		},
	};

	await expect(
		lockActiveAuthorizedProject(client as never, "project", authorization),
	).resolves.toBe(false);
	expect(calls).toHaveLength(4);
	expect(calls[0]).toContain("organization_memberships");
	expect(calls[0]).toContain("FOR UPDATE");
	expect(calls[1]).toContain("project_memberships");
	expect(calls[1]).toContain("FOR UPDATE");
	expect(calls[2]).toContain("p.status = ANY($3::text[])");
	expect(calls[2]).toContain("FOR UPDATE");
	expect(calls[3]).toContain("authorization_allows_project");
});

test("binds only the project fence parameters", async () => {
	const calls: Array<[string, unknown[] | undefined]> = [];
	const client = {
		query: async (statement: string, values?: unknown[]) => {
			calls.push([statement, values]);
			if (statement.includes("organization_memberships"))
				return { rows: [{ actor_subject: "member" }] };
			if (statement.includes("project_memberships"))
				return { rows: [{ actor_subject: "member" }] };
			if (statement.includes("FROM projects p"))
				return { rows: [{ id: "project" }] };
			return { rows: [{ allowed: true }] };
		},
	};

	await expect(
		lockActiveAuthorizedProject(client as never, "project", authorization),
	).resolves.toBe(true);

	expect(calls[2]).toEqual([
		expect.stringContaining("p.status = ANY($3::text[])"),
		["project", authorization.organization_id, ["active"]],
	]);
});
