import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";

export const ProjectRole = z.enum(["manager", "member"]);
export const OrganizationRole = z.enum(["owner", "member"]);
export const ProjectStatus = z.enum(["active", "archived"]);
export const Project = z
	.object({
		id: z.string().uuid(),
		name: z.string(),
		slug: z.string(),
		status: ProjectStatus,
		created_at: z.string().datetime(),
		archived_at: z.string().datetime().nullable(),
	})
	.strict()
	.openapi("Project");
export const ProjectMember = z
	.object({
		actor_subject: z.string().min(1),
		role: ProjectRole,
		created_at: z.string().datetime(),
	})
	.strict()
	.openapi("ProjectMember");
export const OrganizationMember = z
	.object({
		actor_subject: z.string().min(1),
		role: OrganizationRole,
		created_at: z.string().datetime(),
	})
	.strict()
	.openapi("OrganizationMember");
export const ProjectAuditEvent = z
	.object({
		id: z.string().uuid(),
		actor_subject: z.string().min(1),
		event_type: z.string().min(1),
		created_at: z.string().datetime(),
	})
	.strict()
	.openapi("ProjectAuditEvent");
export const ProjectList = z
	.object({ items: z.array(Project), total: z.number().int().nonnegative() })
	.strict()
	.openapi("ProjectList");
export const Me = z
	.object({
		actor_subject: z.string(),
		organization_id: z.string().uuid(),
		organization_role: OrganizationRole,
		projects: z.array(Project),
	})
	.strict()
	.openapi("CurrentActor");
const ProjectName = z.string().trim().min(1).max(200);
const ProjectSlug = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[a-z0-9][a-z0-9-]*$/);
export const CreateProjectInput = z
	.object({
		name: ProjectName,
		slug: ProjectSlug,
	})
	.strict();
export const UpdateProjectInput = z
	.object({ name: ProjectName.optional(), slug: ProjectSlug.optional() })
	.strict()
	.refine((value) => value.name !== undefined || value.slug !== undefined, {
		message: "At least one project field is required",
	});
export const MemberInput = z
	.object({
		actor_subject: z.string().trim().min(1).max(200),
		role: ProjectRole,
	})
	.strict();
export const OrganizationMemberInput = z
	.object({
		actor_subject: z.string().trim().min(1).max(200),
		role: OrganizationRole,
	})
	.strict();
export const ProjectErrorResponses = {
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
		description: "Conflict",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	500: {
		description: "Internal error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
