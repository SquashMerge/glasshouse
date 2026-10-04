import { describe, expect, it } from "bun:test";
import { bootstrapAuthorization } from "../../src/db/bootstrap-authorization";

const ORGANIZATION = "00000000-0000-4000-8000-000000000001";

describe("bootstrap authorization", () => {
	it("rejects unknown bootstrap modes before connecting", async () => {
		let ended = false;
		await expect(
			bootstrapAuthorization({ ASTRAEA_AUTH_BOOTSTRAP_MODE: "unexpected" }, {
				connect: async () => {
					throw new Error("must not connect");
				},
				end: async () => {
					ended = true;
				},
			} as never),
		).rejects.toThrow("ASTRAEA_AUTH_BOOTSTRAP_MODE must be basic or local");
		expect(ended).toBe(true);
	});
	it("grants the configured owner manager membership for every non-deleting project", async () => {
		const queries: Array<{ sql: string; values?: unknown[] }> = [];
		const client = {
			async query(sql: string, values?: unknown[]) {
				queries.push({ sql, values });
				if (sql.includes("INSERT INTO actor_identities"))
					return { rows: [{ actor_id: values?.[0] }], rowCount: 1 };
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
					sql.includes("bootstrap_manager_added") &&
					sql.includes("status <> 'deleting'"),
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
		expect(
			queries.some(
				({ sql }) =>
					sql.includes("INSERT INTO organization_actor_roles") &&
					sql.includes("'admin'"),
			),
		).toBe(true);
	});

	it("provisions durable identities for every configured credential without granting secondary authority", async () => {
		const identityValues: unknown[][] = [];
		const authorityValues: unknown[][] = [];
		const client = {
			async query(sql: string, values?: unknown[]) {
				if (sql.includes("INSERT INTO actor_identities")) {
					identityValues.push(values ?? []);
					return { rows: [{ actor_id: values?.[0] }], rowCount: 1 };
				}
				if (sql.includes("SELECT id FROM organizations"))
					return { rows: [{ id: ORGANIZATION }], rowCount: 1 };
				if (sql.includes("SELECT id FROM projects"))
					return { rows: [], rowCount: 0 };
				if (
					sql.includes("INSERT INTO organization_memberships") ||
					sql.includes("INSERT INTO project_memberships")
				)
					authorityValues.push(values ?? []);
				return { rows: [], rowCount: 1 };
			},
			release() {},
		};
		const pool = { connect: async () => client, end: async () => {} };

		await bootstrapAuthorization(
			{
				ASTRAEA_BOOTSTRAP_OWNER_USERNAME: "owner",
				ASTRAEA_BASIC_AUTH_CREDENTIALS: JSON.stringify([
					{
						username: "owner",
						password: "secret",
						organization_id: ORGANIZATION,
					},
					{
						username: "reader",
						password: "secondary-secret",
						organization_id: "00000000-0000-4000-8000-000000000002",
					},
				]),
			},
			pool as never,
		);

		expect(identityValues).toHaveLength(2);
		expect(identityValues.map((values) => values[0])).not.toEqual([
			identityValues[0]?.[0],
			identityValues[0]?.[0],
		]);
		expect(authorityValues).toHaveLength(2);
		for (const values of authorityValues)
			expect(values).toEqual([ORGANIZATION, "owner"]);
	});

	it("uses an unambiguous actor identity upsert assignment", async () => {
		const queries: string[] = [];
		const client = {
			async query(sql: string) {
				queries.push(sql);
				if (sql.includes("INSERT INTO actor_identities"))
					return { rows: [{ actor_id: "actor" }], rowCount: 1 };
				if (sql.includes("SELECT id FROM organizations"))
					return { rows: [{ id: ORGANIZATION }], rowCount: 1 };
				if (sql.includes("SELECT id FROM projects"))
					return { rows: [], rowCount: 0 };
				return { rows: [], rowCount: 1 };
			},
			release() {},
		};
		const pool = { connect: async () => client, end: async () => {} };

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

		const identityUpsert = queries.find((sql) =>
			sql.includes("INSERT INTO actor_identities"),
		);
		expect(identityUpsert).toContain(
			"DO UPDATE SET actor_id = EXCLUDED.actor_id",
		);
		expect(identityUpsert).not.toContain("DO UPDATE SET actor_id = actor_id");
	});

	it("does not grant recovery authority while any project is deleting", async () => {
		const queries: Array<{ sql: string; values?: unknown[] }> = [];
		const client = {
			async query(sql: string, values?: unknown[]) {
				queries.push({ sql, values });
				if (sql.includes("INSERT INTO actor_identities"))
					return { rows: [{ actor_id: values?.[0] }], rowCount: 1 };
				if (sql.includes("SELECT id FROM organizations"))
					return { rows: [{ id: ORGANIZATION }], rowCount: 1 };
				if (sql.includes("SELECT id FROM projects"))
					return { rows: [{ id: "deleting-project" }], rowCount: 1 };
				return { rows: [], rowCount: 0 };
			},
			release() {},
		};
		const pool = { connect: async () => client, end: async () => {} };

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

		const authorityWrites = queries.filter(
			({ sql }) =>
				sql.includes("INSERT INTO organization_memberships") ||
				sql.includes("INSERT INTO project_memberships"),
		);
		expect(authorityWrites).toHaveLength(2);
		for (const { sql, values } of authorityWrites) {
			expect(sql).toContain("organization_id = $1 AND status = 'deleting'");
			expect(sql).toContain("unfrozen");
			expect(values).toEqual([ORGANIZATION, "owner"]);
		}
	});

	it("fails closed when the canonical Basic identity belongs to another actor", async () => {
		const client = {
			async query(sql: string) {
				if (sql.includes("INSERT INTO actor_identities"))
					return { rows: [], rowCount: 0 };
				return { rows: [], rowCount: 1 };
			},
			release() {},
		};
		const pool = { connect: async () => client, end: async () => {} };

		await expect(
			bootstrapAuthorization(
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
			),
		).rejects.toThrow(/already linked to another actor/);
	});

	it("rolls back before authority grants when any secondary credential is quarantined", async () => {
		const queries: Array<{ sql: string; values?: unknown[] }> = [];
		let conflictChecks = 0;
		const client = {
			async query(sql: string, values?: unknown[]) {
				queries.push({ sql, values });
				if (sql.includes("actor_identity_backfill_quarantine")) {
					conflictChecks += 1;
					return { rows: [{ blocked: conflictChecks === 2 }], rowCount: 1 };
				}
				if (sql.includes("INSERT INTO actor_identities"))
					return { rows: [{ actor_id: values?.[0] }], rowCount: 1 };
				return { rows: [], rowCount: 1 };
			},
			release() {},
		};
		const pool = { connect: async () => client, end: async () => {} };

		await expect(
			bootstrapAuthorization(
				{
					ASTRAEA_BOOTSTRAP_OWNER_USERNAME: "owner",
					ASTRAEA_BASIC_AUTH_CREDENTIALS: JSON.stringify([
						{
							username: "owner",
							password: "secret",
							organization_id: ORGANIZATION,
						},
						{
							username: "blocked-reader",
							password: "secondary-secret",
							organization_id: "00000000-0000-4000-8000-000000000002",
						},
					]),
				},
				pool as never,
			),
		).rejects.toThrow("Bootstrap Basic Auth identity cannot be authorized");

		expect(
			queries.some(
				({ sql }) =>
					sql.includes("INSERT INTO organization_memberships") ||
					sql.includes("INSERT INTO project_memberships"),
			),
		).toBe(false);
		expect(queries.at(-1)?.sql).toBe("ROLLBACK");
	});

	it("rejects quarantined canonical collisions and cross-organization subjects before writes", async () => {
		for (const username of ["Legacy User", "Shared User"]) {
			const queries: Array<{ sql: string; values?: unknown[] }> = [];
			const client = {
				async query(sql: string, values?: unknown[]) {
					queries.push({ sql, values });
					if (sql.includes("actor_identity_backfill_quarantine"))
						return { rows: [{ blocked: true }], rowCount: 1 };
					return { rows: [], rowCount: 1 };
				},
				release() {},
			};
			const pool = { connect: async () => client, end: async () => {} };

			await expect(
				bootstrapAuthorization(
					{
						ASTRAEA_BOOTSTRAP_OWNER_USERNAME: username,
						ASTRAEA_BASIC_AUTH_CREDENTIALS: JSON.stringify([
							{
								username,
								password: "secret",
								organization_id: ORGANIZATION,
							},
						]),
					},
					pool as never,
				),
			).rejects.toThrow("Bootstrap Basic Auth identity cannot be authorized");

			expect(
				queries.some(
					({ sql }) =>
						sql.includes("INSERT INTO actors") ||
						sql.includes("INSERT INTO actor_identities") ||
						sql.includes("INSERT INTO organization_memberships") ||
						sql.includes("INSERT INTO project_memberships"),
				),
			).toBe(false);
			expect(queries.map(({ sql }) => sql)).toEqual([
				"BEGIN",
				expect.any(String),
				"ROLLBACK",
			]);
		}
	});
});
