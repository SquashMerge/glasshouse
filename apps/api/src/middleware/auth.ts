// HTTP Basic Auth middleware for /v1/* routes.
// Single credential via UI_USERNAME / UI_PASSWORD env vars.
// Constant-time compare to avoid timing attacks.

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

function constantTimeEqual(a: string, b: string): boolean {
  const A = new TextEncoder().encode(a);
  const B = new TextEncoder().encode(b);
  if (A.length !== B.length) {
    // Still compare against a same-length buffer to avoid leaking length info via timing.
    const pad = new Uint8Array(A.length);
    timingSafeEqual(pad, pad);
    return false;
  }
  return timingSafeEqual(A, B);
}

function parseBasic(header: string | undefined): { user: string; pass: string } | null {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/.exec(header);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

export function basicAuthMiddleware(): MiddlewareHandler {
  const user = process.env.UI_USERNAME;
  const pass = process.env.UI_PASSWORD;
  if (!user || !pass) {
    throw new Error("basicAuthMiddleware: UI_USERNAME and UI_PASSWORD must be set in the environment");
  }

  return async (c, next) => {
    const got = parseBasic(c.req.header("authorization"));
    if (!got || !constantTimeEqual(got.user, user) || !constantTimeEqual(got.pass, pass)) {
      c.header("WWW-Authenticate", 'Basic realm="astraea", charset="UTF-8"');
      return c.json(
        { code: "UNAUTHORIZED", message: "Authentication required" },
        401,
      );
    }
    await next();
  };
}