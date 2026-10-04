import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	hashLocalPassword,
	validLocalPassword,
	verifyLocalPassword,
	type PasswordHash,
} from "../lib/local-passwords.js";
import {
	lockAuthorizedOrganization,
	withLockPhaseTransaction,
} from "./project-authorization.js";

export const LOCAL_PROVIDER_NAMESPACE = "local:v1";
export class LocalCredentialError extends Error {
	constructor() {
		super("Local credential operation rejected");
	}
}
export function normalizeLocalUsername(username: unknown): string {
	if (
		typeof username !== "string" ||
		/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.exec(username)?.[0] !== username
	)
		throw new LocalCredentialError();
	return username.toLowerCase();
}

export type LocalPrincipal = { organizationId: string; actorId: string };
function tokenDigest(token: string): Buffer {
	if (
		typeof token !== "string" ||
		token.length !== 43 ||
		!/^[A-Za-z0-9_-]{43}$/.test(token) ||
		Buffer.from(token, "base64url").toString("base64url") !== token
	)
		throw new LocalCredentialError();
	return createHash("sha256").update(token).digest();
}
function tokenMatches(token: string, digest: Buffer | null): boolean {
	const actual = tokenDigest(token);
	return (
		digest !== null &&
		digest.length === actual.length &&
		timingSafeEqual(actual, digest)
	);
}
async function transaction<T>(
	pool: Pool,
	run: (client: PoolClient) => Promise<T>,
): Promise<T> {
	return credentialTransaction(pool, async () => {}, run);
}
async function credentialTransaction<T>(
	pool: Pool,
	lock: (client: PoolClient) => Promise<void>,
	run: (client: PoolClient) => Promise<T>,
): Promise<T> {
	try {
		return await withLockPhaseTransaction(pool, lock, run);
	} catch {
		throw new LocalCredentialError();
	}
}
async function lockBootstrap(client: PoolClient, organizationId: string) {
	const result = await client.query<{
		token_digest: Buffer | null;
		available: boolean;
	}>(
		`SELECT token_digest, closed_at IS NULL AND expires_at > clock_timestamp() AS available
		FROM local_bootstrap_controls WHERE organization_id = $1 FOR UPDATE`,
		[organizationId],
	);
	return result.rows[0];
}

// Operator-only boundary; never called from a request or automatically at startup.
export async function provisionLocalBootstrap(
	pool: Pool,
	organizationId: string,
	token: string,
): Promise<void> {
	const digest = tokenDigest(token);
	await transaction(pool, async (client) => {
		await lockBootstrap(client, organizationId);
		const result = await client.query(
			`UPDATE local_bootstrap_controls SET token_digest = $2, provisioned_at = statement_timestamp(), expires_at = statement_timestamp() + interval '24 hours'
			WHERE organization_id = $1 AND closed_at IS NULL AND NOT EXISTS (SELECT 1 FROM organization_actor_roles WHERE organization_id = $1 AND role = 'admin') RETURNING organization_id`,
			[organizationId, digest],
		);
		if (!result.rowCount) throw new LocalCredentialError();
	});
}

async function insertAccount(
	client: PoolClient,
	organizationId: string,
	username: string,
	hash: PasswordHash | null,
): Promise<LocalPrincipal> {
	const actorId = randomUUID();
	await client.query("INSERT INTO actors (id) VALUES ($1)", [actorId]);
	await client.query(
		"INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject) VALUES ($1, $2, $3, $4)",
		[
			actorId,
			organizationId,
			LOCAL_PROVIDER_NAMESPACE,
			`${organizationId}:${username}`,
		],
	);
	await client.query(
		"INSERT INTO local_credentials (organization_id, actor_id, username, password_hash, password_algorithm, password_version) VALUES ($1, $2, $3, $4, $5, $6)",
		[
			organizationId,
			actorId,
			username,
			hash?.password_hash ?? null,
			hash?.password_algorithm ?? null,
			hash?.password_version ?? null,
		],
	);
	return { organizationId, actorId };
}

export class LocalCredentialStore {
	constructor(
		private readonly pool: Pool,
		readonly organizationId: string,
	) {}

	async bootstrap(input: {
		organizationId?: string;
		username: string;
		password: string;
		token: string;
	}): Promise<LocalPrincipal> {
		if (
			input.organizationId !== undefined &&
			input.organizationId !== this.organizationId
		)
			throw new LocalCredentialError();
		const username = normalizeLocalUsername(input.username);
		if (!validLocalPassword(input.password)) throw new LocalCredentialError();
		tokenDigest(input.token);
		const hash = await hashLocalPassword(input.password);
		return transaction(this.pool, async (client) => {
			const control = await lockBootstrap(client, this.organizationId);
			if (
				!control?.available ||
				!tokenMatches(input.token, control.token_digest)
			)
				throw new LocalCredentialError();
			const admin = await client.query(
				"SELECT 1 FROM organization_actor_roles WHERE organization_id = $1 AND role = 'admin' LIMIT 1",
				[this.organizationId],
			);
			if (admin.rowCount) throw new LocalCredentialError();
			const consumed = await client.query(
				"UPDATE local_bootstrap_controls SET closed_at = clock_timestamp(), token_digest = NULL, provisioned_at = NULL, expires_at = NULL WHERE organization_id = $1 AND closed_at IS NULL AND token_digest = $2 AND expires_at > clock_timestamp() RETURNING organization_id",
				[this.organizationId, tokenDigest(input.token)],
			);
			if (!consumed.rowCount) throw new LocalCredentialError();
			const principal = await insertAccount(
				client,
				this.organizationId,
				username,
				hash,
			);
			await client.query(
				"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, 'admin')",
				[this.organizationId, principal.actorId],
			);
			await client.query(
				"SELECT audit_admin_access_event($1, NULL, $2, $2, 'bootstrap_owner_granted')",
				[this.organizationId, principal.actorId],
			);
			return principal;
		});
	}

	async verify(
		username: string,
		password: string,
	): Promise<LocalPrincipal | null> {
		try {
			return await this.verifyStoredCredential(username, password);
		} catch {
			throw new LocalCredentialError();
		}
	}

	private async verifyStoredCredential(
		username: string,
		password: string,
	): Promise<LocalPrincipal | null> {
		let normalized: string;
		try {
			normalized = normalizeLocalUsername(username);
		} catch {
			return null;
		}
		const result = await this.pool.query<
			PasswordHash & { actor_id: string; enabled: boolean }
		>(
			"SELECT actor_id, enabled, password_hash, password_algorithm, password_version FROM local_credentials WHERE organization_id = $1 AND username = $2",
			[this.organizationId, normalized],
		);
		const stored = result.rows[0];
		if (!stored?.enabled || !stored.password_hash) return null;
		const verification = await verifyLocalPassword(password, stored);
		if (!verification.verified) return null;
		const hash = verification.rehash
			? await hashLocalPassword(password)
			: stored;
		// Compare-and-set fences disablement/password changes during expensive verification.
		const accepted = await this.pool.query(
			"UPDATE local_credentials SET password_hash = $4, password_algorithm = $5, password_version = $6, updated_at = CASE WHEN password_hash <> $4 THEN now() ELSE updated_at END WHERE organization_id = $1 AND actor_id = $2 AND password_hash = $3 AND enabled AND password_algorithm = $7 AND password_version = $8 RETURNING actor_id",
			[
				this.organizationId,
				stored.actor_id,
				stored.password_hash,
				hash.password_hash,
				hash.password_algorithm,
				hash.password_version,
				stored.password_algorithm,
				stored.password_version,
			],
		);
		return accepted.rowCount
			? { organizationId: this.organizationId, actorId: stored.actor_id }
			: null;
	}

	async provision(
		initiator: LocalPrincipal,
		input: {
			username: string;
			role: "admin" | "user" | "read_only";
			email?: string;
		},
	): Promise<LocalPrincipal & { enrollmentId: string; token: string }> {
		if (
			initiator.organizationId !== this.organizationId ||
			!["admin", "user", "read_only"].includes(input.role)
		)
			throw new LocalCredentialError();
		const username = normalizeLocalUsername(input.username);
		if (
			input.email !== undefined &&
			(input.email.length > 254 ||
				!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))
		)
			throw new LocalCredentialError();
		const token = randomBytes(32).toString("base64url");
		return credentialTransaction(
			this.pool,
			async (client) => {
				if (
					!(await lockAuthorizedOrganization(
						client,
						this.organizationId,
						initiator.actorId,
						"organization_manage",
					))
				)
					throw new LocalCredentialError();
			},
			async (client) => {
				const principal = await insertAccount(
					client,
					this.organizationId,
					username,
					null,
				);
				await client.query(
					"INSERT INTO organization_actor_roles (organization_id, actor_id, role) VALUES ($1, $2, $3)",
					[this.organizationId, principal.actorId, input.role],
				);
				await client.query(
					"SELECT audit_admin_access_event($1, NULL, $2, $3, 'organization_role_set')",
					[this.organizationId, initiator.actorId, principal.actorId],
				);
				const enrollment = await client.query<{ id: string }>(
					"INSERT INTO local_account_enrollments (organization_id, actor_id, provisioned_by, kind, email, token_digest) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
					[
						this.organizationId,
						principal.actorId,
						initiator.actorId,
						input.email === undefined ? "first_use" : "email_invitation",
						input.email ?? null,
						tokenDigest(token),
					],
				);
				return { ...principal, enrollmentId: enrollment.rows[0]!.id, token };
			},
		);
	}

	async enroll(token: string, password: string): Promise<LocalPrincipal> {
		const digest = tokenDigest(token);
		if (!validLocalPassword(password)) throw new LocalCredentialError();
		const hash = await hashLocalPassword(password);
		return transaction(this.pool, async (client) => {
			const enrollment = await client.query<{ id: string; actor_id: string }>(
				"SELECT id, actor_id FROM local_account_enrollments WHERE organization_id = $1 AND token_digest = $2 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE",
				[this.organizationId, digest],
			);
			const row = enrollment.rows[0];
			if (!row) throw new LocalCredentialError();
			const credential = await client.query(
				"UPDATE local_credentials SET password_hash = $3, password_algorithm = $4, password_version = $5, updated_at = now() WHERE organization_id = $1 AND actor_id = $2 AND enabled AND password_hash IS NULL RETURNING actor_id",
				[
					this.organizationId,
					row.actor_id,
					hash.password_hash,
					hash.password_algorithm,
					hash.password_version,
				],
			);
			if (!credential.rowCount) throw new LocalCredentialError();
			const consumed = await client.query(
				"UPDATE local_account_enrollments SET consumed_at = clock_timestamp() WHERE id = $1 AND expires_at > clock_timestamp() RETURNING id",
				[row.id],
			);
			if (!consumed.rowCount) throw new LocalCredentialError();
			return { organizationId: this.organizationId, actorId: row.actor_id };
		});
	}

	async revokeEnrollment(
		initiator: LocalPrincipal,
		enrollmentId: string,
	): Promise<void> {
		if (initiator.organizationId !== this.organizationId)
			throw new LocalCredentialError();
		await credentialTransaction(
			this.pool,
			async (client) => {
				if (
					!(await lockAuthorizedOrganization(
						client,
						this.organizationId,
						initiator.actorId,
						"organization_manage",
					))
				)
					throw new LocalCredentialError();
			},
			async (client) => {
				const result = await client.query(
					"UPDATE local_account_enrollments SET revoked_at = clock_timestamp() WHERE id = $1 AND organization_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id",
					[enrollmentId, this.organizationId],
				);
				if (!result.rowCount) throw new LocalCredentialError();
			},
		);
	}
}
