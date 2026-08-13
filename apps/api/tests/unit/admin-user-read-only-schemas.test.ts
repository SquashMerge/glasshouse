import { expect, test } from "bun:test";
import {
	ActorProjectRole,
	OrganizationMemberInput,
	OrganizationRole,
	Project,
	ProjectRole,
} from "../../src/schemas/projects";

test("publishes Admin/User/Read-only roles without accepting raw legacy roles", () => {
	expect(ProjectRole.options).toEqual(["user", "read_only"]);
	expect(ActorProjectRole.options).toEqual(["admin", "user", "read_only"]);
	expect(OrganizationRole.options).toEqual(["admin", "user", "read_only"]);
	expect(ProjectRole.safeParse("manager").success).toBe(false);
	expect(
		OrganizationMemberInput.safeParse({
			actor_subject: "reader",
			role: "owner",
		}).success,
	).toBe(false);
	expect(
		Project.safeParse({
			id: "11111111-1111-4111-8111-111111111111",
			name: "Project",
			slug: "project",
			status: "active",
			created_at: "2026-08-11T00:00:00.000Z",
			archived_at: null,
			project_role: "admin",
			can_manage: true,
			can_govern: true,
			is_default: false,
		}).success,
	).toBe(true);
});
