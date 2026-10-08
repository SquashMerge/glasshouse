import { expect, spyOn, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createHash, randomBytes } from "node:crypto";
import { LocalCredentialStore } from "../../src/db/local-credentials";
import * as postgres from "../../src/db/postgres";
import {
	basicCredentialsFromEnvironment,
	TRUSTED_TENANT_CONTEXT_KEY,
} from "../../src/middleware/auth";
import {
	handleRecoverAdmin,
	recoverAdmin,
} from "../../src/routes/admin-access";

const organizationId = "00000000-0000-4000-8000-000000000001";

for (const operation of ["bootstrap", "recovery"] as const) {
	for (const code of ["40P01", "40001"]) {
		test(`${operation} retries first-Admin serialization only in the lock phase (${code})`, async () => {
			const token = randomBytes(32).toString("base64url");
			const queries: Array<{ sql: string; values?: unknown[] }> = [];
			let locks = 0;
			let mutations = 0;
			const client = {
				async query(sql: string, values?: unknown[]) {
					queries.push({ sql, values });
					if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
						locks += 1;
						if (locks === 1)
							throw Object.assign(new Error("lock failed"), { code });
					}
					if (sql.includes("FROM local_bootstrap_controls"))
						return {
							rows: [
								{
									available: true,
									token_digest: createHash("sha256").update(token).digest(),
								},
							],
							rowCount: 1,
						};
					if (sql.startsWith("SELECT 1 FROM organization_actor_roles"))
						return { rows: [], rowCount: 0 };
					if (sql.startsWith("INSERT INTO organization_actor_roles")) {
						mutations += 1;
						return {
							rows: [
								{
									actor_id: values?.[1],
									organization_role: "admin",
									created_at: new Date(),
								},
							],
							rowCount: 1,
						};
					}
					return { rows: [], rowCount: 1 };
				},
				release() {},
			};
			const database = { connect: async () => client };
			if (operation === "bootstrap") {
				await new LocalCredentialStore(
					database as never,
					organizationId,
				).bootstrap({
					username: "Race.Admin",
					password: randomBytes(32).toString("base64url"),
					token,
				});
			} else {
				const previous = {
					credentials: process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS,
					owner: process.env.GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME,
				};
				const poolProvider = spyOn(postgres, "pgPool").mockReturnValue(
					database as never,
				);
				try {
					process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS = JSON.stringify([
						{
							username: "owner",
							password: randomBytes(32).toString("base64url"),
							organization_id: organizationId,
						},
					]);
					process.env.GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME = "owner";
					const owner = basicCredentialsFromEnvironment()[0]!;
					const api = new OpenAPIHono();
					api.use("*", async (c, next) => {
						c.set(TRUSTED_TENANT_CONTEXT_KEY, {
							actor: owner.username,
							actorId: owner.actorId,
							organizationId,
						});
						await next();
					});
					api.openapi(recoverAdmin, handleRecoverAdmin);
					const response = await api.request("/v1/admin/recovery", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ confirmation: "RESTORE ADMIN" }),
					});
					expect(response.status).toBe(200);
					expect(await response.json()).toMatchObject({ username: "owner" });
				} finally {
					poolProvider.mockRestore();
					for (const [key, value] of [
						["GLASSHOUSE_BASIC_AUTH_CREDENTIALS", previous.credentials],
						["GLASSHOUSE_BOOTSTRAP_OWNER_USERNAME", previous.owner],
					] as const) {
						if (value === undefined) delete process.env[key];
						else process.env[key] = value;
					}
				}
			}
			expect(locks).toBe(2);
			expect(mutations).toBe(1);
			expect(queries.slice(0, 5)).toEqual([
				{ sql: "BEGIN", values: undefined },
				{
					sql: expect.stringContaining("pg_advisory_xact_lock"),
					values: [organizationId],
				},
				{ sql: "ROLLBACK", values: undefined },
				{ sql: "BEGIN", values: undefined },
				{
					sql: expect.stringContaining("pg_advisory_xact_lock"),
					values: [organizationId],
				},
			]);
			expect(queries[1]!.sql).not.toContain(", 51)");
			expect(queries.at(-1)?.sql).toBe("COMMIT");
		});
	}
}
