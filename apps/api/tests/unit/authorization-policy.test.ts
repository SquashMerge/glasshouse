import { describe, expect, it } from "bun:test";
import {
	effectiveRoleForOrganizationRole,
	projectOperationAllowed,
} from "../../src/authorization-policy";

describe("Admin/User/Read-only authorization policy", () => {
	it("maps every organization role to access across its organization", () => {
		expect(effectiveRoleForOrganizationRole("admin")).toBe("admin");
		expect(effectiveRoleForOrganizationRole("user")).toBe("user");
		expect(effectiveRoleForOrganizationRole("read_only")).toBe("read_only");
		expect(effectiveRoleForOrganizationRole(null)).toBeNull();
	});

	it("denies Read-only writes in every enforcement mode", () => {
		for (const enforcement of ["compatibility", "strict"] as const)
			expect(
				projectOperationAllowed(enforcement, "read_only", "product_write"),
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

	it("allows Read-only project evidence reads in every enforcement mode", () => {
		for (const enforcement of ["compatibility", "strict"] as const)
			expect(
				projectOperationAllowed(enforcement, "read_only", "audit_read"),
			).toBe(true);
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

	it("reserves project lifecycle access for Admins in every enforcement mode", () => {
		for (const enforcement of ["compatibility", "strict"] as const)
			expect(
				projectOperationAllowed(enforcement, "user", "project_manage"),
			).toBe(false);
	});

	it("reserves governance access for Admins in every enforcement mode", () => {
		for (const enforcement of ["compatibility", "strict"] as const)
			expect(projectOperationAllowed(enforcement, "user", "governed")).toBe(
				false,
			);
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
