export type AuthorizationEnforcement = "compatibility" | "strict";
export type EffectiveProjectRole = "admin" | "user" | "read_only";
export type ProjectOperation =
	| "product_read"
	| "product_write"
	| "curation_write"
	| "execute"
	| "ingest"
	| "audit_read"
	| "governed"
	| "release_gate_manage"
	| "destructive"
	| "project_manage";

const projectOperations: readonly ProjectOperation[] = [
	"product_read",
	"product_write",
	"curation_write",
	"execute",
	"ingest",
	"audit_read",
	"governed",
	"release_gate_manage",
	"destructive",
	"project_manage",
];

export function effectiveRoleForOrganizationRole(
	organizationRole: string | null,
): EffectiveProjectRole | null {
	if (
		organizationRole === "admin" ||
		organizationRole === "user" ||
		organizationRole === "read_only"
	)
		return organizationRole;
	return null;
}

export function projectOperationAllowed(
	_enforcement: AuthorizationEnforcement,
	role: EffectiveProjectRole,
	operation: ProjectOperation,
): boolean {
	if (role === "admin") return projectOperations.includes(operation);
	if (role === "user")
		return [
			"product_read",
			"product_write",
			"curation_write",
			"execute",
			"ingest",
			"audit_read",
		].includes(operation);
	return operation === "product_read" || operation === "audit_read";
}
