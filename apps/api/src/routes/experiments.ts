import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { Experiment, ExperimentCreate, ExperimentList, ExperimentResults, ExperimentSummary, ExperimentStubResponses } from "../schemas/experiments.js";
import { IdParam } from "../schemas/common.js";
import { notImplemented } from "./_stub.js";

const tag = "experiments";

export const createExperiment = createRoute({
  method: "post",
  path: "/v1/experiments",
  tags: [tag],
  summary: "Create an experiment",
  request: { body: { content: { "application/json": { schema: ExperimentCreate } } } },
  responses: { 201: { description: "Experiment created", content: { "application/json": { schema: Experiment } } }, ...ExperimentStubResponses },
});
export const handleCreateExperiment = () => notImplemented();

export const listExperiments = createRoute({
  method: "get",
  path: "/v1/experiments",
  tags: [tag],
  summary: "List experiments",
  responses: { 200: { description: "OK", content: { "application/json": { schema: ExperimentList } } }, ...ExperimentStubResponses },
});
export const handleListExperiments = () => notImplemented();

export const getExperiment = createRoute({
  method: "get",
  path: "/v1/experiments/{id}",
  tags: [tag],
  summary: "Get an experiment",
  request: { params: IdParam },
  responses: { 200: { description: "OK", content: { "application/json": { schema: Experiment } } }, ...ExperimentStubResponses },
});
export const handleGetExperiment = (_id: string) => notImplemented();

export const getExperimentResults = createRoute({
  method: "get",
  path: "/v1/experiments/{id}/results",
  tags: [tag],
  summary: "Get experiment results",
  request: { params: IdParam },
  responses: { 200: { description: "OK", content: { "application/json": { schema: ExperimentResults } } }, ...ExperimentStubResponses },
});
export const handleGetExperimentResults = (_id: string) => notImplemented();

export const getExperimentSummary = createRoute({
  method: "get",
  path: "/v1/experiments/{id}/summary",
  tags: [tag],
  summary: "Get experiment summary",
  request: { params: IdParam },
  responses: { 200: { description: "OK", content: { "application/json": { schema: ExperimentSummary } } }, ...ExperimentStubResponses },
});
export const handleGetExperimentSummary = (_id: string) => notImplemented();

export const getExperimentEvents = createRoute({
  method: "get",
  path: "/v1/experiments/{id}/events",
  tags: [tag],
  summary: "SSE stream of experiment events",
  request: { params: IdParam },
  responses: { 200: { description: "OK (text/event-stream)", content: { "text/event-stream": { schema: z.string() } } }, ...ExperimentStubResponses },
});
export const handleGetExperimentEvents = (_id: string) => notImplemented();

export const cancelExperiment = createRoute({
  method: "post",
  path: "/v1/experiments/{id}/cancel",
  tags: [tag],
  summary: "Cancel a running experiment",
  request: { params: IdParam },
  responses: { 200: { description: "OK", content: { "application/json": { schema: Experiment } } }, ...ExperimentStubResponses },
});
export const handleCancelExperiment = (_id: string) => notImplemented();