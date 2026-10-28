import { beforeEach, describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { TRUSTED_TENANT_CONTEXT_KEY } from "../../src/middleware/auth";
import {
	getOrganizationUsageRoute,
	createOrganizationUsageHandler,
	listEligibleOrganizationUsageProjects,
} from "../../src/routes/organization-usage";
import type {
	OrganizationUsageDashboard,
	UsageProject,
} from "../../src/db/organization-usage";

const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION = "00000000-0000-4000-8000-000000000002";
const actorIds = {
	admin: "11111111-1111-4111-8111-111111111111",
	user: "22222222-2222-4222-8222-222222222222",
	read_only: "33333333-3333-4333-8333-333333333333",
	non_member: "44444444-4444-4444-8444-444444444444",
	cross_org: "55555555-5555-4555-8555-555555555555",
} as const;
const projects: UsageProject[] = [
	{
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		name: "One",
		slug: "one",
		status: "active",
	},
	{
		id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		name: "Archived",
		slug: "archived",
		status: "archived",
	},
];
const responseData: OrganizationUsageDashboard = {
	range: "30d",
	from: "2026-09-28T00:00:00.000Z",
	to: "2026-10-28T00:00:00.000Z",
	projects: projects.map((project) => ({
		...project,
		traces: 0,
		observations: 0,
		observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
	})),
	totals: {
		traces: 0,
		observations: 0,
		observations_by_type: { span: 0, event: 0, generation: 0, tool: 0 },
	},
	series: [],
};

const membershipCalls: Array<{ organizationId: string; actorId: string }> = [];
const usageCalls: Array<{
	organizationId: string;
	projectIds: string[];
	range: string;
}> = [];
const app = new OpenAPIHono();
app.use("/v1/*", async (c, next) => {
	const actor = c.req.header("x-test-actor") as
		| keyof typeof actorIds
		| undefined;
	if (actor) {
		c.set(TRUSTED_TENANT_CONTEXT_KEY, {
			actor,
			actorId: actorIds[actor],
			organizationId: actor === "cross_org" ? OTHER_ORGANIZATION : ORGANIZATION,
		});
	}
	await next();
});
app.openapi(
	getOrganizationUsageRoute,
	createOrganizationUsageHandler({
		isOrganizationMember: async (organizationId, actorId) => {
			membershipCalls.push({ organizationId, actorId });
			return actorId !== actorIds.non_member && organizationId === ORGANIZATION;
		},
		listProjects: async (organizationId) =>
			organizationId === ORGANIZATION ? projects : [],
		getUsage: async (organizationId, selectedProjects, range) => {
			usageCalls.push({
				organizationId,
				projectIds: selectedProjects.map((project) => project.id),
				range,
			});
			return { ...responseData, range, projects: responseData.projects };
		},
	}),
);

async function request(
	actor?: keyof typeof actorIds,
	path = "/v1/organization/usage?range=30d",
) {
	return app.request(`http://localhost${path}`, {
		headers: actor ? { "x-test-actor": actor } : {},
	});
}

beforeEach(() => {
	membershipCalls.length = 0;
	usageCalls.length = 0;
});

describe("organization usage dashboard route", () => {
	it("lists only same-organization active and archived Projects", async () => {
		const statements: Array<{ sql: string; parameters: unknown[] }> = [];
		const pool = {
			query: async (sql: string, parameters: unknown[]) => {
				statements.push({ sql, parameters });
				return { rows: projects };
			},
		};

		expect(
			await listEligibleOrganizationUsageProjects(pool as never, ORGANIZATION),
		).toEqual(projects);
		expect(statements).toEqual([
			{
				sql: "SELECT id, name, slug, status FROM projects WHERE organization_id = $1 AND status IN ('active', 'archived') ORDER BY slug, id",
				parameters: [ORGANIZATION],
			},
		]);
	});

	it("returns the same all-project aggregate for every organization role", async () => {
		const responses = await Promise.all([
			request("admin"),
			request("user"),
			request("read_only"),
		]);
		const bodies = await Promise.all(
			responses.map((response) => response.json()),
		);

		expect(responses.map((response) => response.status)).toEqual([
			200, 200, 200,
		]);
		expect(bodies[0]).toEqual(bodies[1]);
		expect(bodies[1]).toEqual(bodies[2]);
		expect(bodies[0]).toMatchObject({
			projects: [
				{ id: projects[0]!.id },
				{ id: projects[1]!.id, status: "archived" },
			],
		});
		expect(membershipCalls.map((call) => call.organizationId)).toEqual([
			ORGANIZATION,
			ORGANIZATION,
			ORGANIZATION,
		]);
		expect(usageCalls.map((call) => call.projectIds)).toEqual([
			projects.map((project) => project.id),
			projects.map((project) => project.id),
			projects.map((project) => project.id),
		]);
	});

	it("requires authenticated active organization membership and discloses nothing otherwise", async () => {
		const unauthenticated = await request();
		const nonMember = await request("non_member");
		const crossOrganization = await request("cross_org");

		expect(unauthenticated.status).toBe(401);
		expect(nonMember.status).toBe(404);
		expect(crossOrganization.status).toBe(404);
		expect(await nonMember.json()).toEqual({
			code: "NOT_FOUND",
			message: "Organization is not available",
		});
		expect(await crossOrganization.json()).toEqual({
			code: "NOT_FOUND",
			message: "Organization is not available",
		});
		expect(usageCalls).toEqual([]);
	});

	it("does not accept caller-selected organization scope", async () => {
		const response = await request(
			"admin",
			"/v1/organization/usage?range=30d&organization_id=" + OTHER_ORGANIZATION,
		);
		expect(response.status).toBe(400);
		expect(usageCalls).toEqual([]);
	});
});
