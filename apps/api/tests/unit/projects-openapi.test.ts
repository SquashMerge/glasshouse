import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
	deleteProject,
	handleDeleteProject,
	handleSetDefaultProject,
	setDefaultProject,
} from "../../src/routes/projects";

describe("project OpenAPI contracts", () => {
	it("requires default-project and permanent-deletion JSON bodies", () => {
		const app = new OpenAPIHono();
		app.openapi(setDefaultProject, handleSetDefaultProject);
		app.openapi(deleteProject, handleDeleteProject);
		const document = app.getOpenAPIDocument({
			openapi: "3.1.0",
			info: { title: "test", version: "1" },
		});

		expect(
			document.paths?.["/v1/organizations/current/default-project"]?.patch
				?.requestBody?.required,
		).toBe(true);
		expect(
			document.paths?.["/v1/projects/{id}"]?.delete?.requestBody?.required,
		).toBe(true);
	});
});
