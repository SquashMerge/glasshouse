import { describe, expect, it, mock } from "bun:test";
import {
	TenantScopeError,
	withActiveAuthorizedProjectLock,
	withActiveInternalEvaluationProjectLock,
} from "../../src/tenancy";
import { evaluationWorkerActorId } from "../../src/db/actors";

const scope = {
	actor: "member",
	actorId: "00000000-0000-4000-8000-000000000003",
	organizationId: "00000000-0000-4000-8000-000000000001",
	projectId: "00000000-0000-4000-8000-000000000002",
	projectRole: "read_only" as const,
	enforcement: "strict" as const,
	projectStatus: "active" as const,
};

describe("withActiveAuthorizedProjectLock", () => {
	it("locks active project through the centralized policy decision", async () => {
		const query = mock(async (statement: string) => {
			if (statement.includes("p.status = ANY($3::text[])"))
				return { rows: [{ id: "project" }] };
			if (statement.includes("organization_memberships"))
				return { rows: [{ actor_subject: "member" }] };
			if (statement.includes("organization_actor_roles"))
				return { rows: [{ actor_id: scope.actorId }] };
			if (statement.includes("project_memberships"))
				return { rows: [{ actor_subject: "member" }] };
			if (statement.includes("project_actor_grants"))
				return { rows: [{ actor_id: scope.actorId }] };
			if (statement.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
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
			expect.stringContaining("local_credentials"),
			expect.stringContaining("organization_memberships"),
			expect.stringContaining("organization_actor_roles"),
			expect.stringContaining("project_memberships"),
			expect.stringContaining("project_actor_grants"),
			expect.stringContaining("p.status = ANY($3::text[])"),
			expect.stringContaining("authorization_allows_project"),
			"COMMIT",
		]);
		expect(query.mock.calls[6]?.[0]).toContain("FOR UPDATE OF p");
		expect(persisted).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("retries a lock-phase deadlock before any persistence", async () => {
		let attempt = 0;
		const query = mock(async (statement: string) => {
			if (statement === "BEGIN") {
				attempt += 1;
				return { rows: [] };
			}
			if (attempt === 1 && statement.includes("p.status = ANY($3::text[])"))
				throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
			if (statement.includes("p.status = ANY($3::text[])"))
				return { rows: [{ id: scope.projectId }] };
			if (statement.includes("organization_memberships"))
				return { rows: [{ actor_subject: scope.actor }] };
			if (statement.includes("organization_actor_roles"))
				return { rows: [{ actor_id: scope.actorId }] };
			if (statement.includes("project_memberships"))
				return { rows: [{ actor_subject: scope.actor }] };
			if (statement.includes("project_actor_grants"))
				return { rows: [{ actor_id: scope.actorId }] };
			if (statement.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			return { rows: [] };
		});
		const release = mock(() => undefined);
		const db = {
			connect: mock(async () => ({ query, release })),
		} as never;
		const persisted = mock(async () => undefined);

		await withActiveAuthorizedProjectLock(db, scope, persisted);

		expect(attempt).toBe(2);
		expect(persisted).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(2);
		expect(query.mock.calls.map(([statement]) => statement)).toEqual([
			"BEGIN",
			expect.stringContaining("local_credentials"),
			expect.stringContaining("organization_memberships"),
			expect.stringContaining("organization_actor_roles"),
			expect.stringContaining("project_memberships"),
			expect.stringContaining("project_actor_grants"),
			expect.stringContaining("p.status = ANY($3::text[])"),
			"ROLLBACK",
			"BEGIN",
			expect.stringContaining("local_credentials"),
			expect.stringContaining("organization_memberships"),
			expect.stringContaining("organization_actor_roles"),
			expect.stringContaining("project_memberships"),
			expect.stringContaining("project_actor_grants"),
			expect.stringContaining("p.status = ANY($3::text[])"),
			expect.stringContaining("authorization_allows_project"),
			"COMMIT",
		]);
	});

	it("does not retry after a callback has run", async () => {
		const serializationFailure = Object.assign(
			new Error("could not serialize access"),
			{ code: "40001" },
		);
		const query = mock(async (statement: string) => {
			if (statement.includes("p.status = ANY($3::text[])"))
				return { rows: [{ id: scope.projectId }] };
			if (statement.includes("organization_memberships"))
				return { rows: [{ actor_subject: scope.actor }] };
			if (statement.includes("organization_actor_roles"))
				return { rows: [{ actor_id: scope.actorId }] };
			if (statement.includes("project_memberships"))
				return { rows: [{ actor_subject: scope.actor }] };
			if (statement.includes("project_actor_grants"))
				return { rows: [{ actor_id: scope.actorId }] };
			if (statement.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			if (statement === "COMMIT") throw serializationFailure;
			return { rows: [] };
		});
		const db = {
			connect: mock(async () => ({ query, release: () => undefined })),
		} as never;
		const persisted = mock(async () => undefined);

		await expect(
			withActiveAuthorizedProjectLock(db, scope, persisted),
		).rejects.toBe(serializationFailure);

		expect(persisted).toHaveBeenCalledTimes(1);
		expect(db.connect).toHaveBeenCalledTimes(1);
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
				expect.stringContaining("local_credentials"),
				expect.stringContaining("organization_memberships"),
				expect.stringContaining("organization_actor_roles"),
				expect.stringContaining("project_memberships"),
				expect.stringContaining("project_actor_grants"),
				expect.stringContaining("p.status = ANY($3::text[])"),
				"ROLLBACK",
			]);
		}
	});

	it("preserves a persistence failure when rollback fails", async () => {
		const failure = new Error("ClickHouse failed");
		const query = mock(async (statement: string) => {
			if (statement.includes("p.status = ANY($3::text[])"))
				return { rows: [{ id: "project" }] };
			if (statement.includes("organization_memberships"))
				return { rows: [{ actor_subject: "member" }] };
			if (statement.includes("organization_actor_roles"))
				return { rows: [{ actor_id: scope.actorId }] };
			if (statement.includes("project_memberships"))
				return { rows: [{ actor_subject: "member" }] };
			if (statement.includes("project_actor_grants"))
				return { rows: [{ actor_id: scope.actorId }] };
			if (statement.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
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

	describe("withActiveInternalEvaluationProjectLock", () => {
		const internalScope = {
			actor: "internal:evaluation-worker",
			actorId: evaluationWorkerActorId(scope.organizationId),
			organizationId: scope.organizationId,
			projectId: scope.projectId,
		};

		it("locks only an active project matched to its durable internal actor", async () => {
			const query = mock(async (statement: string) => {
				if (statement.startsWith("SELECT"))
					return { rows: [{ id: scope.projectId }] };
				return { rows: [] };
			});
			const persisted = mock(async () => undefined);
			const db = {
				connect: mock(async () => ({ query, release: () => undefined })),
			} as never;

			await withActiveInternalEvaluationProjectLock(
				db,
				internalScope,
				persisted,
			);

			const [statement, values] = query.mock.calls[1] ?? [];
			expect(statement).toContain(
				"worker.provider_namespace = 'internal:evaluation-worker:v1'",
			);
			expect(statement).toContain(
				"worker.canonical_subject = p.organization_id::text",
			);
			expect(statement).toContain("p.status = 'active'");
			expect(statement).toContain("FOR UPDATE OF p");
			expect(statement).not.toContain("organization_memberships");
			expect(statement).not.toContain("project_memberships");
			expect(values).toEqual([
				internalScope.projectId,
				internalScope.organizationId,
				internalScope.actorId,
			]);
			expect(persisted).toHaveBeenCalledTimes(1);
		});

		it("fails closed without persisting when the internal actor cannot lock the project", async () => {
			const query = mock(async (statement: string) =>
				statement.startsWith("SELECT") ? { rows: [] } : { rows: [] },
			);
			const persisted = mock(async () => undefined);
			const db = {
				connect: mock(async () => ({ query, release: () => undefined })),
			} as never;

			await expect(
				withActiveInternalEvaluationProjectLock(db, internalScope, persisted),
			).rejects.toBeInstanceOf(TenantScopeError);
			expect(persisted).not.toHaveBeenCalled();
			expect(query.mock.calls.map(([statement]) => statement)).toEqual([
				"BEGIN",
				expect.any(String),
				"ROLLBACK",
			]);
		});
	});
});
