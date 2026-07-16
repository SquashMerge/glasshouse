import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import {
	Agent,
	AgentCreate,
	AgentPatch,
	AgentList,
	AgentStubResponses,
} from "../schemas/agents.js";
import { IdParam } from "../schemas/common.js";
import { notImplemented } from "./_stub.js";

const tag = "agents";

export const createAgent = createRoute({
	method: "post",
	path: "/v1/agents",
	tags: [tag],
	summary: "Create an agent",
	request: {
		body: { content: { "application/json": { schema: AgentCreate } } },
	},
	responses: {
		201: {
			description: "Agent created",
			content: { "application/json": { schema: Agent } },
		},
		...AgentStubResponses,
	},
});
export const handleCreateAgent = () => notImplemented();

export const listAgents = createRoute({
	method: "get",
	path: "/v1/agents",
	tags: [tag],
	summary: "List agents",
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: AgentList } },
		},
		...AgentStubResponses,
	},
});
export const handleListAgents = () => notImplemented();

export const getAgent = createRoute({
	method: "get",
	path: "/v1/agents/{id}",
	tags: [tag],
	summary: "Get an agent",
	request: { params: IdParam },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: Agent } },
		},
		...AgentStubResponses,
	},
});
export const handleGetAgent = (_id: string) => notImplemented();

export const patchAgent = createRoute({
	method: "patch",
	path: "/v1/agents/{id}",
	tags: [tag],
	summary: "Update an agent",
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: AgentPatch } } },
	},
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: Agent } },
		},
		...AgentStubResponses,
	},
});
export const handlePatchAgent = (_id: string) => notImplemented();

export const deleteAgent = createRoute({
	method: "delete",
	path: "/v1/agents/{id}",
	tags: [tag],
	summary: "Delete an agent",
	request: { params: IdParam },
	responses: { 204: { description: "No content" }, ...AgentStubResponses },
});
export const handleDeleteAgent = (_id: string) => notImplemented();

export const syncAgent = createRoute({
	method: "post",
	path: "/v1/agents/{id}/sync",
	tags: [tag],
	summary: "Sync agent manifest from SDK introspection",
	request: { params: IdParam },
	responses: {
		200: {
			description: "OK",
			content: { "application/json": { schema: Agent } },
		},
		...AgentStubResponses,
	},
});
export const handleSyncAgent = (_id: string) => notImplemented();

export const runAgent = createRoute({
	method: "post",
	path: "/v1/agents/{id}/run",
	tags: [tag],
	summary: "Run an agent invocation",
	request: {
		params: IdParam,
		body: {
			content: {
				"application/json": {
					schema: z.object({ input: z.record(z.unknown()) }),
				},
			},
		},
	},
	responses: {
		200: {
			description: "OK",
			content: {
				"application/json": { schema: z.object({ output: z.unknown() }) },
			},
		},
		...AgentStubResponses,
	},
});
export const handleRunAgent = (_id: string) => notImplemented();

export const listAgentVersions = createRoute({
	method: "get",
	path: "/v1/agents/{id}/versions",
	tags: [tag],
	summary: "List agent manifest versions",
	request: { params: IdParam },
	responses: {
		200: {
			description: "OK",
			content: {
				"application/json": { schema: z.object({ items: z.array(Agent) }) },
			},
		},
		...AgentStubResponses,
	},
});
export const handleListAgentVersions = (_id: string) => notImplemented();
