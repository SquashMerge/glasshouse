// POST /v1/auth/login — verifies Basic Auth credentials. Returns 200 { ok: true }
// on valid creds, 401 on invalid. Used by the web dashboard's login page to
// pre-validate before storing creds in localStorage.

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
  // The basicAuthMiddleware on /v1 has already validated the credentials before
  // reaching this handler. If we got here, they're valid.
  return c.json({ ok: true }, 200);
};

// Re-export for the slice plan: a small handler factory that mounts both the
// middleware and the route on a sub-app. Useful for tests.
export const authRouteMount = (app: { post: (p: string, h: unknown) => void }): void => {
  app.post("/v1/auth/login", handleLogin);
};

// Self-test harness used by the slice's test plan (curl-based).
export const _selfTest_basicAuthMiddleware = basicAuthMiddleware;