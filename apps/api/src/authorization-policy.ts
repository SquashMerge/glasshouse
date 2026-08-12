export type AuthorizationEnforcement = "compatibility" | "strict";
export type EffectiveProjectRole = "admin" | "user" | "read_only";
export type ProjectOperation =
	| "product_read"
	| "product_write"
	| "execute"
	| "ingest"
	| "audit_read"
	| "governed"
	| "destructive"
	| "project_manage";

const projectOperations: readonly ProjectOperation[] = [
	"product_read",
	"product_write",
	"execute",
	"ingest",
	"audit_read",
	"governed",
	"destructive",
	"project_manage",
];

export function effectiveRoleForLegacyAssignment(
	organizationRole: string | null,
	projectRole: string | null,
): EffectiveProjectRole | null {
	if (organizationRole === "owner") return "admin";
	if (organizationRole !== "member") return null;
	if (projectRole === "manager") return "user";
	if (projectRole === "member") return "read_only";
	return null;
}

export function projectOperationAllowed(
	enforcement: AuthorizationEnforcement,
	role: EffectiveProjectRole,
	operation: ProjectOperation,
): boolean {
	if (role === "admin") return projectOperations.includes(operation);
	if (role === "user" && enforcement === "compatibility")
		return [
			"product_read",
			"product_write",
			"execute",
			"ingest",
			"audit_read",
			"project_manage",
			"governed",
		].includes(operation);
	if (role === "user")
		return [
			"product_read",
			"product_write",
			"execute",
			"ingest",
			"audit_read",
		].includes(operation);
	if (enforcement === "compatibility")
		return ["product_read", "product_write", "execute", "ingest"].includes(
			operation,
		);
	return operation === "product_read" || operation === "audit_read";
}
