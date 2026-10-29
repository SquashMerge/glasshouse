import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;
type Row = Record<string, unknown>;

export type OtlpCredential = {
	id: string;
	organization_id: string;
	project_id: string;
	name: string;
	secret_prefix: string;
	created_by_actor_id: string;
	created_at: string;
	rotated_at: string | null;
	revoked_at: string | null;
	last_used_at: string | null;
};

export type OtlpCredentialWithSecret = {
	credential: OtlpCredential;
	secret: string;
};

export type AuthenticatedOtlpCredential = {
	id: string;
	organizationId: string;
	projectId: string;
	actorId: string;
};

export class OtlpCredentialNotFoundError extends Error {
	constructor() {
		super("Credential not found");
		this.name = "OtlpCredentialNotFoundError";
	}
}

function timestamp(row: Row, key: string): string | null {
	const value = row[key];
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "string") return value;
	throw new Error(`Persisted OTLP credential ${key} is invalid`);
}

function text(row: Row, key: string): string {
	const value = row[key];
	if (typeof value !== "string")
		throw new Error(`Persisted OTLP credential ${key} is invalid`);
	return value;
}

function mapCredential(row: Row): OtlpCredential {
	return {
		id: text(row, "id"),
		organization_id: text(row, "organization_id"),
		project_id: text(row, "project_id"),
		name: text(row, "name"),
		secret_prefix: text(row, "secret_prefix"),
		created_by_actor_id: text(row, "created_by_actor_id"),
		created_at: timestamp(row, "created_at")!,
		rotated_at: timestamp(row, "rotated_at"),
		revoked_at: timestamp(row, "revoked_at"),
		last_used_at: timestamp(row, "last_used_at"),
	};
}

export function generateOtlpCredentialSecret(): {
	secret: string;
	digest: string;
	prefix: string;
} {
	const secret = `gh_ing_${randomBytes(32).toString("base64url")}`;
	return {
		secret,
		digest: createHash("sha256").update(secret, "utf8").digest("hex"),
		prefix: secret.slice(0, 14),
	};
}

export async function createOtlpCredential(
	client: Queryable,
	input: {
		organization_id: string;
		project_id: string;
		name: string;
		created_by_actor_id: string;
	},
): Promise<OtlpCredentialWithSecret> {
	const name = input.name.trim();
	if (!name || name.length > 100)
		throw new Error("Credential name must be between 1 and 100 characters");
	const generated = generateOtlpCredentialSecret();
	const result = await client.query(
		"INSERT INTO project_otlp_credentials (organization_id, project_id, name, secret_digest, secret_prefix, created_by_actor_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, organization_id, project_id, name, secret_prefix, created_by_actor_id, created_at, rotated_at, revoked_at, last_used_at",
		[
			input.organization_id,
			input.project_id,
			name,
			generated.digest,
			generated.prefix,
			input.created_by_actor_id,
		],
	);
	const row = (result.rows as Row[])[0];
	if (!row) throw new Error("Credential insert returned no row");
	return { credential: mapCredential(row), secret: generated.secret };
}

export async function listOtlpCredentials(
	client: Queryable,
	input: { organization_id: string; project_id: string },
): Promise<{ items: OtlpCredential[] }> {
	const result = await client.query(
		"SELECT id, organization_id, project_id, name, secret_prefix, created_by_actor_id, created_at, rotated_at, revoked_at, last_used_at FROM project_otlp_credentials WHERE organization_id = $1 AND project_id = $2 ORDER BY created_at DESC, id",
		[input.organization_id, input.project_id],
	);
	return { items: (result.rows as Row[]).map(mapCredential) };
}

export async function rotateOtlpCredential(
	client: Queryable,
	input: { organization_id: string; project_id: string; id: string },
): Promise<OtlpCredentialWithSecret> {
	const generated = generateOtlpCredentialSecret();
	const result = await client.query(
		"UPDATE project_otlp_credentials SET secret_digest = $4, secret_prefix = $5, rotated_at = now(), last_used_at = NULL WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND revoked_at IS NULL RETURNING id, organization_id, project_id, name, secret_prefix, created_by_actor_id, created_at, rotated_at, revoked_at, last_used_at",
		[
			input.organization_id,
			input.project_id,
			input.id,
			generated.digest,
			generated.prefix,
		],
	);
	const row = (result.rows as Row[])[0];
	if (!row) throw new OtlpCredentialNotFoundError();
	return { credential: mapCredential(row), secret: generated.secret };
}

export async function revokeOtlpCredential(
	client: Queryable,
	input: { organization_id: string; project_id: string; id: string },
): Promise<OtlpCredential> {
	const result = await client.query(
		"UPDATE project_otlp_credentials SET revoked_at = COALESCE(revoked_at, now()) WHERE organization_id = $1 AND project_id = $2 AND id = $3 RETURNING id, organization_id, project_id, name, secret_prefix, created_by_actor_id, created_at, rotated_at, revoked_at, last_used_at",
		[input.organization_id, input.project_id, input.id],
	);
	const row = (result.rows as Row[])[0];
	if (!row) throw new OtlpCredentialNotFoundError();
	return mapCredential(row);
}

export async function authenticateOtlpCredential(
	client: Queryable,
	secret: string,
): Promise<AuthenticatedOtlpCredential | null> {
	if (!/^gh_ing_[A-Za-z0-9_-]{43}$/.test(secret)) return null;
	const digest = createHash("sha256").update(secret, "utf8").digest("hex");
	const result = await client.query(
		"SELECT id, organization_id, project_id, created_by_actor_id FROM project_otlp_credentials WHERE secret_digest = $1 AND revoked_at IS NULL LIMIT 1",
		[digest],
	);
	const row = (result.rows as Row[])[0];
	if (!row) return null;
	return {
		id: text(row, "id"),
		organizationId: text(row, "organization_id"),
		projectId: text(row, "project_id"),
		actorId: text(row, "created_by_actor_id"),
	};
}

export async function lockActiveOtlpCredential(
	client: Queryable,
	input: AuthenticatedOtlpCredential & { digest: string },
): Promise<boolean> {
	const result = await client.query(
		"SELECT id FROM project_otlp_credentials WHERE id = $1 AND organization_id = $2 AND project_id = $3 AND created_by_actor_id = $4 AND secret_digest = $5 AND revoked_at IS NULL FOR SHARE",
		[
			input.id,
			input.organizationId,
			input.projectId,
			input.actorId,
			input.digest,
		],
	);
	if (!result.rows[0]) return false;
	await client.query(
		"UPDATE project_otlp_credentials SET last_used_at = now() WHERE id = $1 AND organization_id = $2 AND project_id = $3 AND secret_digest = $4 AND revoked_at IS NULL",
		[input.id, input.organizationId, input.projectId, input.digest],
	);
	return true;
}
