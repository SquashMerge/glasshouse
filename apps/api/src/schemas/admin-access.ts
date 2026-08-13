import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";

const ActorId = z.string().uuid();
const Timestamp = z.string().datetime();

export const AdminRole = z.enum(["admin", "user", "read_only"]);
export const GrantRole = z.enum(["user", "read_only"]);

export const AdminActor = z
	.object({
		actor_id: ActorId,
		organization_role: AdminRole.nullable(),
		created_at: Timestamp,
	})
	.strict()
	.openapi("AdminActor");

export const ProjectGrant = z
	.object({
		actor_id: ActorId,
		project_id: ActorId,
		role: GrantRole,
		created_at: Timestamp,
	})
	.strict()
	.openapi("ProjectGrant");

export const AdminAuditEvent = z
	.object({
		id: ActorId,
		actor_id: ActorId,
		target_actor_id: ActorId.nullable(),
		organization_id: ActorId,
		project_id: ActorId.nullable(),
		action: z.string().min(1),
		correlation_id: ActorId,
		created_at: Timestamp,
	})
	.strict()
	.openapi("AdminAuditEvent");

export const OrganizationRoleInput = z
	.object({ role: AdminRole })
	.strict()
	.openapi("OrganizationRoleInput");

export const ProjectGrantInput = z
	.object({ role: GrantRole })
	.strict()
	.openapi("ProjectGrantInput");

export const RecoveryInput = z
	.object({ confirmation: z.literal("RESTORE ADMIN") })
	.strict()
	.openapi("RecoveryInput");

export const AdminErrorResponses = {
	400: {
		description: "Invalid request",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	401: {
		description: "Authentication required",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	403: {
		description: "Insufficient role",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	404: {
		description: "Not found",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	409: {
		description: "Conflicting access state",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	429: {
		description: "Recovery cooldown",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	500: {
		description: "Internal error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
