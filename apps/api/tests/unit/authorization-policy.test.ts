import { describe, expect, it } from "bun:test";
import {
	effectiveRoleForLegacyAssignment,
	projectOperationAllowed,
} from "../../src/authorization-policy";

describe("Admin/User/Read-only authorization policy", () => {
	it("maps legacy assignments explicitly without granting cross-project access", () => {
		expect(effectiveRoleForLegacyAssignment("owner", null)).toBe("admin");
		expect(effectiveRoleForLegacyAssignment("member", "manager")).toBe("user");
		expect(effectiveRoleForLegacyAssignment("member", "member")).toBe(
			"read_only",
		);
		expect(effectiveRoleForLegacyAssignment("member", null)).toBeNull();
		expect(effectiveRoleForLegacyAssignment("owner", "member")).toBe("admin");
	});

	it("preserves legacy member product access only until strict enforcement is enabled", () => {
		expect(
			projectOperationAllowed("compatibility", "read_only", "product_write"),
		).toBe(true);
		expect(
			projectOperationAllowed("strict", "read_only", "product_write"),
		).toBe(false);
	});

	it("denies Read-only curation in compatibility and strict enforcement", () => {
		for (const enforcement of ["compatibility", "strict"] as const)
			expect(
				projectOperationAllowed(enforcement, "read_only", "curation_write"),
			).toBe(false);
	});

	it("denies Read-only writes and governed actions while allowing only project evidence reads", () => {
		for (const operation of [
			"product_write",
			"curation_write",
			"execute",
			"ingest",
			"governed",
			"destructive",
			"project_manage",
		] as const)
			expect(projectOperationAllowed("strict", "read_only", operation)).toBe(
				false,
			);
		expect(projectOperationAllowed("strict", "read_only", "product_read")).toBe(
			true,
		);
		expect(projectOperationAllowed("strict", "read_only", "audit_read")).toBe(
			true,
		);
	});

	it("does not broaden legacy member audit visibility during compatibility", () => {
		expect(
			projectOperationAllowed("compatibility", "read_only", "audit_read"),
		).toBe(false);
		expect(projectOperationAllowed("strict", "read_only", "audit_read")).toBe(
			true,
		);
	});

	it("limits Users to ordinary project work and reserves governed operations for Admins", () => {
		expect(projectOperationAllowed("strict", "user", "product_write")).toBe(
			true,
		);
		expect(projectOperationAllowed("strict", "user", "curation_write")).toBe(
			true,
		);
		expect(projectOperationAllowed("strict", "user", "execute")).toBe(true);
		expect(projectOperationAllowed("strict", "user", "governed")).toBe(false);
		expect(projectOperationAllowed("strict", "admin", "destructive")).toBe(
			true,
		);
		expect(projectOperationAllowed("strict", "admin", "unknown" as never)).toBe(
			false,
		);
	});

	it("keeps legacy manager lifecycle access during compatibility without carrying it into strict mode", () => {
		expect(
			projectOperationAllowed("compatibility", "user", "project_manage"),
		).toBe(true);
		expect(projectOperationAllowed("strict", "user", "project_manage")).toBe(
			false,
		);
	});

	it("keeps legacy manager governance access only during compatibility", () => {
		expect(projectOperationAllowed("compatibility", "user", "governed")).toBe(
			true,
		);
		expect(projectOperationAllowed("strict", "user", "governed")).toBe(false);
	});

	it("keeps release-gate approval and invocation Admin-only in every enforcement mode", () => {
		for (const enforcement of ["compatibility", "strict"] as const) {
			expect(
				projectOperationAllowed(enforcement, "admin", "release_gate_manage"),
			).toBe(true);
			expect(
				projectOperationAllowed(enforcement, "user", "release_gate_manage"),
			).toBe(false);
			expect(
				projectOperationAllowed(
					enforcement,
					"read_only",
					"release_gate_manage",
				),
			).toBe(false);
		}
	});
});
