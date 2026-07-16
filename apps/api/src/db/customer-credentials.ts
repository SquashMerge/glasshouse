import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

export const CUSTOMER_CREDENTIAL_SCOPES = ["prompts:read", "prompts:render", "prompts:write"] as const;
export type CustomerCredentialScope = (typeof CUSTOMER_CREDENTIAL_SCOPES)[number];

export type CustomerCredential = {
  id: string;
  project_id: string;
  display_name: string;
  prefix: string;
  fingerprint: string;
  scopes: CustomerCredentialScope[];
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

export type CustomerCredentialWithSecret = CustomerCredential & { secret: string };
export type AuthenticatedCustomerCredential = Pick<CustomerCredential, "id" | "project_id" | "scopes">;

export class CustomerCredentialRepositoryError extends Error {
  readonly status: 400 | 404 | 409 | 500;

  constructor(
    readonly code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "INTERNAL",
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CustomerCredentialRepositoryError";
    this.status = code === "BAD_REQUEST" ? 400 : code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 500;
  }
}

type Row = Record<string, unknown>;

function failure(code: CustomerCredentialRepositoryError["code"], message: string, cause?: unknown): CustomerCredentialRepositoryError {
  return new CustomerCredentialRepositoryError(code, message, cause);
}

function databaseCode(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" ? value.code : undefined;
}

function normalizeError(value: unknown): CustomerCredentialRepositoryError {
  if (value instanceof CustomerCredentialRepositoryError) return value;
  if (databaseCode(value) === "23503") return failure("NOT_FOUND", "Project not found", value);
  if (databaseCode(value) === "23505") return failure("CONFLICT", "Credential already exists", value);
  return failure("INTERNAL", "Customer credential operation failed", value);
}

function stringValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw failure("INTERNAL", `Persisted credential ${key} is invalid`);
  return value;
}

function timestampValue(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  throw failure("INTERNAL", `Persisted credential ${key} is invalid`);
}

function scopeValues(value: unknown): CustomerCredentialScope[] {
  const scopes = Array.isArray(value) ? value : typeof value === "string" ? value.replace(/^\{?|\}?$/g, "").split(",").filter(Boolean) : null;
  if (!scopes || scopes.length === 0 || !scopes.every((scope): scope is CustomerCredentialScope => CUSTOMER_CREDENTIAL_SCOPES.includes(scope as CustomerCredentialScope))) {
    throw failure("INTERNAL", "Persisted credential scopes are invalid");
  }
  return scopes;
}

function mapCredential(row: Row): CustomerCredential {
  return {
    id: stringValue(row, "id"),
    project_id: stringValue(row, "project_id"),
    display_name: stringValue(row, "display_name"),
    prefix: stringValue(row, "secret_prefix"),
    fingerprint: stringValue(row, "secret_fingerprint"),
    scopes: scopeValues(row.scopes),
    created_by: stringValue(row, "created_by"),
    created_at: timestampValue(row, "created_at")!,
    expires_at: timestampValue(row, "expires_at"),
    revoked_at: timestampValue(row, "revoked_at"),
    last_used_at: timestampValue(row, "last_used_at"),
  };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function safelyEqualHashes(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length !== b.length) {
    timingSafeEqual(Buffer.alloc(Math.max(a.length, b.length)), Buffer.alloc(Math.max(a.length, b.length)));
    return false;
  }
  return timingSafeEqual(a, b);
}

export function generateCustomerCredentialSecret(): { secret: string; hash: string; prefix: string; fingerprint: string } {
  const secret = `astraea_ck_${randomBytes(32).toString("base64url")}`;
  const hash = hashSecret(secret);
  return { secret, hash, prefix: secret.slice(0, 20), fingerprint: hash.slice(-12) };
}

function normalizedScopes(value: unknown): CustomerCredentialScope[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((scope): scope is CustomerCredentialScope => typeof scope === "string" && CUSTOMER_CREDENTIAL_SCOPES.includes(scope as CustomerCredentialScope))) {
    throw failure("BAD_REQUEST", "scopes must contain one or more supported prompt scopes");
  }
  return [...new Set(value)];
}

function normalizedExpiry(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || Date.parse(value) <= Date.now()) {
    throw failure("BAD_REQUEST", "expires_at must be a future ISO timestamp");
  }
  return value;
}

const credentialColumns = "id, project_id, display_name, secret_prefix, secret_fingerprint, scopes, created_by, created_at, expires_at, revoked_at, last_used_at";

export async function listCustomerCredentials(pool: Pick<Pool, "query">, projectId: string): Promise<{ items: CustomerCredential[] }> {
  try {
    const rows = await pool.query(`SELECT ${credentialColumns} FROM customer_api_credentials WHERE project_id = $1 ORDER BY created_at DESC`, [projectId]);
    return { items: (rows.rows as Row[]).map(mapCredential) };
  } catch (cause) {
    throw normalizeError(cause);
  }
}

export async function createCustomerCredential(
  pool: Pick<Pool, "query">,
  input: { project_id: string; display_name: string; scopes: CustomerCredentialScope[]; created_by: string; expires_at?: string | null },
): Promise<CustomerCredentialWithSecret> {
  const displayName = typeof input.display_name === "string" ? input.display_name.trim() : "";
  if (!displayName) throw failure("BAD_REQUEST", "display_name must not be blank");
  if (typeof input.created_by !== "string" || !input.created_by.trim()) throw failure("INTERNAL", "Trusted actor is unavailable");
  const generated = generateCustomerCredentialSecret();
  const scopes = normalizedScopes(input.scopes);
  const expiresAt = normalizedExpiry(input.expires_at);
  try {
    const rows = await pool.query(
      `INSERT INTO customer_api_credentials (project_id, display_name, secret_hash, secret_prefix, secret_fingerprint, scopes, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${credentialColumns}`,
      [input.project_id, displayName, generated.hash, generated.prefix, generated.fingerprint, scopes, input.created_by, expiresAt],
    );
    const row = (rows.rows as Row[])[0];
    if (!row) throw failure("INTERNAL", "Credential insert returned no row");
    return { ...mapCredential(row), secret: generated.secret };
  } catch (cause) {
    throw normalizeError(cause);
  }
}

export async function revokeCustomerCredential(pool: Pick<Pool, "query">, input: { project_id: string; id: string }): Promise<CustomerCredential> {
  try {
    const rows = await pool.query(
      `UPDATE customer_api_credentials
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE id = $1 AND project_id = $2
       RETURNING ${credentialColumns}`,
      [input.id, input.project_id],
    );
    const row = (rows.rows as Row[])[0];
    if (!row) throw failure("NOT_FOUND", "Credential not found");
    return mapCredential(row);
  } catch (cause) {
    throw normalizeError(cause);
  }
}

export async function authenticateCustomerCredential(pool: Pick<Pool, "query">, secret: string): Promise<AuthenticatedCustomerCredential | null> {
  const hash = hashSecret(secret);
  try {
    const rows = await pool.query(
      `SELECT id, project_id, scopes, secret_hash
       FROM customer_api_credentials
       WHERE secret_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
       LIMIT 1`,
      [hash],
    );
    const row = (rows.rows as Row[])[0];
    if (!row || !safelyEqualHashes(hash, stringValue(row, "secret_hash"))) return null;
    const credential = { id: stringValue(row, "id"), project_id: stringValue(row, "project_id"), scopes: scopeValues(row.scopes) };
    await pool.query("UPDATE customer_api_credentials SET last_used_at = now() WHERE id = $1", [credential.id]);
    return credential;
  } catch {
    return null;
  }
}
