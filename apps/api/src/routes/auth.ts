import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { ErrorEnvelope } from "../schemas/common.js";
import { basicAuthMiddleware } from "../middleware/auth.js";

const tag = "auth";

export const loginRoute = createRoute({
  method: "post",
  path: "/v1/auth/login",
  tags: [tag],
  summary: "Verify Basic Auth credentials",
  description:
    "Used by the web dashboard login page to pre-validate creds before storing in localStorage. The endpoint requires Basic Auth itself — pass the same credentials you're trying to verify.",
  security: [{ basicAuth: [] }],
  responses: {
    200: {
      description: "Credentials valid",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: {
      description: "Credentials invalid",
      content: { "application/json": { schema: ErrorEnvelope } },
    },
  },
});

export const handleLogin = async (c: { req: { header: (k: string) => string | undefined } }): Promise<Response> => {
  // basicAuthMiddleware on /v1 has already validated the credentials before reaching here.
  return c.json({ ok: true }, 200);
};

export const authRouteMount = (app: { post: (p: string, h: unknown) => void }): void => {
  app.post("/v1/auth/login", handleLogin);
};

export const _selfTest_basicAuthMiddleware = basicAuthMiddleware;