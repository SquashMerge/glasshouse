import { afterEach, expect, test, mock } from "bun:test";
import { createHash } from "node:crypto";
import {
	authenticateOtlpCredential,
	createOtlpCredential,
	generateOtlpCredentialSecret,
	revokeOtlpCredential,
	rotateOtlpCredential,
} from "../../src/db/otlp-credentials";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000010";
const PROJECT_ID = "00000000-0000-4000-8000-000000000011";
const CREDENTIAL_ID = "00000000-0000-4000-8000-000000000012";
const ACTOR_ID = "00000000-0000-4000-8000-000000000013";

afterEach(() => mock.restore());

test("generated OTLP secrets contain 256 random bits and are represented by a SHA-256 digest", () => {
	const generated = generateOtlpCredentialSecret();
	expect(generated.secret).toMatch(/^gh_ing_[A-Za-z0-9_-]{43}$/);
	expect(generated.digest).toBe(
		createHash("sha256").update(generated.secret, "utf8").digest("hex"),
	);
	expect(generated.prefix).toBe(generated.secret.slice(0, 14));
});

test("credential creation returns the secret once and persists only its digest and safe scope metadata", async () => {
	const query = mock(async (_sql: string, values: unknown[]) => ({
		rows: [
			{
				id: CREDENTIAL_ID,
				organization_id: ORGANIZATION_ID,
				project_id: PROJECT_ID,
				name: "payments worker",
				secret_prefix: values[2],
				created_by_actor_id: ACTOR_ID,
				created_at: new Date("2026-10-01T00:00:00Z"),
				rotated_at: null,
				revoked_at: null,
				last_used_at: null,
			},
		],
	}));

	const result = await createOtlpCredential({ query } as never, {
		organization_id: ORGANIZATION_ID,
		project_id: PROJECT_ID,
		name: " payments worker ",
		created_by_actor_id: ACTOR_ID,
	});
	const secret = result.secret;
	const sql = query.mock.calls[0]?.[0] ?? "";
	const values = query.mock.calls[0]?.[1] ?? [];
	expect(secret).toMatch(/^gh_ing_[A-Za-z0-9_-]{43}$/);
	expect(result.credential).toMatchObject({
		id: CREDENTIAL_ID,
		project_id: PROJECT_ID,
		name: "payments worker",
	});
	expect(sql).toContain("secret_digest");
	expect(values).toContain(
		createHash("sha256").update(secret, "utf8").digest("hex"),
	);
	expect(values).not.toContain(secret);
});

test("authentication looks up only an active exact digest and returns the immutable bound actor and Project", async () => {
	const secret = generateOtlpCredentialSecret().secret;
	const query = mock(async () => ({
		rows: [
			{
				id: CREDENTIAL_ID,
				organization_id: ORGANIZATION_ID,
				project_id: PROJECT_ID,
				created_by_actor_id: ACTOR_ID,
			},
		],
	}));
	const credential = await authenticateOtlpCredential(
		{ query } as never,
		secret,
	);
	const sql = query.mock.calls[0]?.[0] ?? "";
	expect(credential).toEqual({
		id: CREDENTIAL_ID,
		organizationId: ORGANIZATION_ID,
		projectId: PROJECT_ID,
		actorId: ACTOR_ID,
	});
	expect(sql).toContain("revoked_at IS NULL");
	expect(query.mock.calls[0]?.[1]).toEqual([
		createHash("sha256").update(secret, "utf8").digest("hex"),
	]);
});

test("rotation replaces the digest and returns a new one-time secret without restoring revoked credentials", async () => {
	const query = mock(async (_sql: string, values: unknown[]) => ({
		rows: [
			{
				id: CREDENTIAL_ID,
				organization_id: ORGANIZATION_ID,
				project_id: PROJECT_ID,
				name: "payments worker",
				secret_prefix: values[0],
				created_by_actor_id: ACTOR_ID,
				created_at: new Date(),
				rotated_at: new Date(),
				revoked_at: null,
				last_used_at: null,
			},
		],
	}));
	const result = await rotateOtlpCredential({ query } as never, {
		organization_id: ORGANIZATION_ID,
		project_id: PROJECT_ID,
		id: CREDENTIAL_ID,
	});
	const digest = createHash("sha256")
		.update(result.secret, "utf8")
		.digest("hex");
	expect(result.secret).toMatch(/^gh_ing_[A-Za-z0-9_-]{43}$/);
	expect(query.mock.calls[0]?.[0]).toContain("revoked_at IS NULL");
	expect(query.mock.calls[0]?.[1]).toContain(digest);
	expect(query.mock.calls[0]?.[1]).not.toContain(result.secret);
});

test("revocation is scoped by organization, Project, and credential id", async () => {
	const query = mock(async () => ({
		rows: [
			{
				id: CREDENTIAL_ID,
				organization_id: ORGANIZATION_ID,
				project_id: PROJECT_ID,
				name: "payments worker",
				secret_prefix: "gh_ing_abc",
				created_by_actor_id: ACTOR_ID,
				created_at: new Date(),
				rotated_at: null,
				revoked_at: new Date(),
				last_used_at: null,
			},
		],
	}));
	await revokeOtlpCredential({ query } as never, {
		organization_id: ORGANIZATION_ID,
		project_id: PROJECT_ID,
		id: CREDENTIAL_ID,
	});
	expect(query.mock.calls[0]?.[0]).toContain(
		"organization_id = $1 AND project_id = $2 AND id = $3",
	);
	expect(query.mock.calls[0]?.[1]).toEqual([
		ORGANIZATION_ID,
		PROJECT_ID,
		CREDENTIAL_ID,
	]);
});
