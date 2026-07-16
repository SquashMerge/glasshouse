import { describe, expect, it, mock } from "bun:test";
import {
  authenticateCustomerCredential,
  createCustomerCredential,
  generateCustomerCredentialSecret,
} from "../../src/db/customer-credentials";

const PROJECT = "11111111-1111-4111-8111-111111111111";

describe("customer credential repository", () => {
  it("generates distinct opaque secrets and hashes without embedding the secret", () => {
    const first = generateCustomerCredentialSecret();
    const second = generateCustomerCredentialSecret();

    expect(first.secret).toStartWith("astraea_ck_");
    expect(first.secret).not.toBe(second.secret);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.hash).not.toContain(first.secret);
    expect(first.prefix).toBe(first.secret.slice(0, 20));
  });

  it("persists only the hash and returns the secret on the creation result", async () => {
    const query = mock(async (_text: string, values: unknown[]) => ({
      rows: [{
        id: "550e8400-e29b-41d4-a716-446655440000", project_id: PROJECT, display_name: "Renderer",
        secret_prefix: values[3], secret_fingerprint: values[4], scopes: values[5], created_by: "admin",
        created_at: "2026-07-16T10:00:00.000Z", expires_at: null, revoked_at: null, last_used_at: null,
      }],
    }));

    const created = await createCustomerCredential({ query } as never, {
      project_id: PROJECT, display_name: "Renderer", scopes: ["prompts:read"], created_by: "admin",
    });

    const values = query.mock.calls[0]?.[1] as unknown[];
    expect(values).toContain(created.prefix);
    expect(values).toContain(created.fingerprint);
    expect(values[2]).toMatch(/^[a-f0-9]{64}$/);
    expect(values).not.toContain(created.secret);
    expect(created.secret).toStartWith("astraea_ck_");
  });

  it("fails closed for missing, revoked, or expired credential lookups", async () => {
    const query = mock(async () => ({ rows: [] }));
    const result = await authenticateCustomerCredential({ query } as never, "astraea_ck_not-a-real-secret");

    expect(result).toBeNull();
    expect(query.mock.calls[0]?.[0]).toContain("revoked_at IS NULL");
    expect(query.mock.calls[0]?.[0]).toContain("expires_at IS NULL OR expires_at > now()");
  });
});
