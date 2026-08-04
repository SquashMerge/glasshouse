import { describe, expect, it, mock } from "bun:test";
import {
	TenantScopeError,
	withActiveAuthorizedProjectLock,
} from "../../src/tenancy";

const scope = {
	actor: "member",
	organizationId: "00000000-0000-4000-8000-000000000001",
	projectId: "00000000-0000-4000-8000-000000000002",
	organizationRole: "member" as const,
	projectRole: "member" as const,
	projectStatus: "active" as const,
};

describe("withActiveAuthorizedProjectLock", () => {
	it("locks active project and current memberships through persistence", async () => {
		const query = mock(async (statement: string) => {
			if (statement.startsWith("SELECT")) return { rows: [{ id: "project" }] };
			return { rows: [] };
		});
		const release = mock(() => undefined);
		const db = {
			connect: mock(async () => ({ query, release })),
		} as never;
		const persisted = mock(async () => undefined);

		await withActiveAuthorizedProjectLock(db, scope, persisted);

		expect(query.mock.calls.map(([statement]) => statement)).toEqual([
			"BEGIN",
			expect.stringContaining("p.status = 'active'"),
			"COMMIT",
		]);
		expect(query.mock.calls[1]?.[0]).toContain("FOR UPDATE OF p, om");
		expect(query.mock.calls[1]?.[0]).toContain(
			"project_memberships WHERE project_id = p.id AND actor_subject = $2 FOR UPDATE",
		);
		expect(persisted).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("does not persist after archive or membership revocation revalidation fails", async () => {
		for (const reason of ["archived", "revoked"]) {
			const query = mock(async (statement: string) => {
				if (statement.startsWith("SELECT")) return { rows: [] };
				return { rows: [] };
			});
			const persisted = mock(async () => undefined);
			const db = {
				connect: mock(async () => ({ query, release: () => undefined })),
			} as never;

			await expect(
				withActiveAuthorizedProjectLock(db, scope, persisted),
			).rejects.toBeInstanceOf(TenantScopeError);
			expect(persisted, reason).not.toHaveBeenCalled();
			expect(query.mock.calls.map(([statement]) => statement)).toEqual([
				"BEGIN",
				expect.any(String),
				"ROLLBACK",
			]);
		}
	});

	it("preserves a persistence failure when rollback fails", async () => {
		const failure = new Error("ClickHouse failed");
		const query = mock(async (statement: string) => {
			if (statement.startsWith("SELECT")) return { rows: [{ id: "project" }] };
			if (statement === "ROLLBACK") throw new Error("rollback failed");
			return { rows: [] };
		});
		const db = {
			connect: mock(async () => ({ query, release: () => undefined })),
		} as never;

		await expect(
			withActiveAuthorizedProjectLock(db, scope, async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
	});
});
