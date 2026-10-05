import { expect, test } from "bun:test";
import {
	AdminActor,
	AdminRole,
	OrganizationRoleInput,
	RecoveryInput,
} from "../../src/schemas/admin-access";

test("admin contracts use durable actor IDs and only Admin, User, and Read-only roles", () => {
	const actorId = "11111111-1111-4111-8111-111111111111";

	expect(AdminRole.options).toEqual(["admin", "user", "read_only"]);
	expect(
		AdminActor.safeParse({
			actor_id: actorId,
			username: "reader",
			organization_role: "read_only",
			created_at: "2026-08-13T00:00:00.000Z",
		}).success,
	).toBe(true);
	expect(
		AdminActor.safeParse({
			actor_id: actorId,
			username: null,
			organization_role: null,
			created_at: "2026-08-13T00:00:00.000Z",
		}).success,
	).toBe(true);
	expect(
		AdminActor.safeParse({
			actor_subject: "owner",
			organization_role: "admin",
			created_at: "2026-08-13T00:00:00.000Z",
		}).success,
	).toBe(false);
	expect(OrganizationRoleInput.safeParse({ role: "owner" }).success).toBe(
		false,
	);
	expect(
		RecoveryInput.safeParse({ confirmation: "RESTORE ADMIN" }).success,
	).toBe(true);
});
