import type { MiddlewareHandler } from "hono";
import {
  authenticateCustomerCredential,
  type AuthenticatedCustomerCredential,
  type CustomerCredentialScope,
} from "../db/customer-credentials.js";
import { pgPool } from "../db/postgres.js";

export const CUSTOMER_CREDENTIAL_CONTEXT_KEY = "customerCredential";

function bearerToken(header: string | undefined): string | null {
  if (!header || header.length > 8192) return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/i.exec(header);
  return match?.[1] ?? null;
}

export function customerCredentialAuthMiddleware(
  dependencies: {
    pool?: typeof pgPool;
    authenticate?: typeof authenticateCustomerCredential;
  } = {},
): MiddlewareHandler {
  const pool = dependencies.pool ?? pgPool;
  const authenticate = dependencies.authenticate ?? authenticateCustomerCredential;
  return async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    const credential = token ? await authenticate(pool(), token) : null;
    if (!credential) {
      c.header("WWW-Authenticate", 'Bearer realm="astraea-customer"');
      return c.json({ code: "UNAUTHORIZED", message: "Customer credential required" }, 401);
    }
    c.set(CUSTOMER_CREDENTIAL_CONTEXT_KEY, credential);
    await next();
  };
}

export function customerCredential(c: { get(key: typeof CUSTOMER_CREDENTIAL_CONTEXT_KEY): unknown }): AuthenticatedCustomerCredential | null {
  const value = c.get(CUSTOMER_CREDENTIAL_CONTEXT_KEY);
  return typeof value === "object" && value !== null && "id" in value && "project_id" in value && "scopes" in value
    ? value as AuthenticatedCustomerCredential
    : null;
}

export function hasCustomerCredentialScope(
  c: { get(key: typeof CUSTOMER_CREDENTIAL_CONTEXT_KEY): unknown },
  scope: CustomerCredentialScope,
): boolean {
  return customerCredential(c)?.scopes.includes(scope) ?? false;
}
