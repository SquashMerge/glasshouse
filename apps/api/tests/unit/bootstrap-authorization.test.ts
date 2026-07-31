import { describe, expect, it } from "bun:test";
import { bootstrapAuthorization } from "../../src/db/bootstrap-authorization";

const ORGANIZATION = "00000000-0000-4000-8000-000000000001";

describe("bootstrap authorization", () => {
	it("grants the configured owner manager membership for every project", async () => {
		const queries: Array<{ sql: string; values?: unknown[] }> = [];
		const client = {
			async query(sql: string, values?: unknown[]) {
				queries.push({ sql, values });
				if (sql.includes("SELECT id FROM organizations"))
					return { rows: [{ id: ORGANIZATION }], rowCount: 1 };
				if (sql.includes("SELECT id FROM projects"))
					return {
						rows: [{ id: "project-one" }, { id: "project-two" }],
						rowCount: 2,
					};
				return { rows: [], rowCount: 1 };
			},
			release() {},
		};
		let ended = false;
		const pool = {
			connect: async () => client,
			end: async () => {
				ended = true;
			},
		};

		await bootstrapAuthorization(
			{
				ASTRAEA_BOOTSTRAP_OWNER_USERNAME: "owner",
				ASTRAEA_BASIC_AUTH_CREDENTIALS: JSON.stringify([
					{
						username: "owner",
						password: "secret",
						organization_id: ORGANIZATION,
					},
				]),
			},
			pool as never,
		);

		const projectQuery = queries.find(({ sql }) =>
			sql.includes("SELECT id FROM projects"),
		);
		expect(projectQuery?.sql).toContain("WHERE organization_id = $1");
		expect(projectQuery?.sql).not.toContain("slug = 'default'");
		expect(projectQuery?.sql).not.toContain("status = 'active'");
		expect(
			queries.some(({ sql }) =>
				sql.includes("SELECT id, $1, $2, 'manager' FROM projects"),
			),
		).toBe(true);
		expect(
			queries.some(
				({ sql }) =>
					sql.includes("bootstrap_owner_added") &&
					sql.includes("project_id") &&
					sql.includes("WHERE organization_id = $1"),
			),
		).toBe(true);
		expect(ended).toBe(true);
	});
});
