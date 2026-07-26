import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "./common.js";

export const Project = z
	.object({
		id: z.string().uuid(),
		name: z.string(),
		slug: z.string(),
		created_at: z.string().datetime(),
	})
	.strict()
	.openapi("Project");

export const ProjectList = z
	.object({
		items: z.array(Project),
		total: z.number().int().nonnegative(),
	})
	.strict()
	.openapi("ProjectList");

export const ProjectErrorResponses = {
	500: {
		description: "Internal error",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
