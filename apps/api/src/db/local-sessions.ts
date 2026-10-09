import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TrustedTenantContext } from "../middleware/auth.js";
import {
	hashLocalPassword,
	verifyLocalPassword,
	type PasswordHash,
} from "../lib/local-passwords.js";
import { logger } from "../lib/logger.js";
import {
	LocalCredentialStore,
	normalizeLocalUsername,
} from "./local-credentials.js";

export const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;
export const SESSION_COOKIE = "glasshouse_session";
export const CSRF_HEADER = "x-glasshouse-csrf";
export class AuthenticationError extends Error {
	constructor() {
		super("Authentication required");
	}
}
export function sessionDigest(token: string): Buffer | null {
	if (
		!/^[A-Za-z0-9_-]{43}$/.test(token) ||
		Buffer.from(token, "base64url").toString("base64url") !== token
	)
		return null;
	return createHash("sha256").update(token).digest();
}
export function csrfForSession(token: string): string {
	return createHash("sha256")
		.update("glasshouse:csrf:v1:")
		.update(token)
		.digest("base64url");
}
export function validSessionCsrf(
	token: string,
	provided: string | undefined,
): boolean {
	if (
		!provided ||
		provided.length !== 43 ||
		!/^[A-Za-z0-9_-]{43}$/.test(provided)
	)
		return false;
	return timingSafeEqual(
		Buffer.from(csrfForSession(token)),
		Buffer.from(provided),
	);
}

type SessionRow = {
	id: string;
	organization_id: string;
	actor_id: string;
	expires_at: Date;
};
export type SessionPrincipal = TrustedTenantContext & { sessionId: string };
type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export async function lockLocalActor(
	client: Queryable,
	organizationId: string,
	actorId: string,
): Promise<boolean> {
	const result = await client.query<{ enabled: boolean; ready: boolean }>(
		"SELECT enabled, password_hash IS NOT NULL AS ready FROM local_credentials WHERE organization_id = $1 AND actor_id = $2 FOR SHARE",
		[organizationId, actorId],
	);
	return !result.rows[0] || (result.rows[0].enabled && result.rows[0].ready);
}

export async function lockSessionPrincipal(
	client: Queryable,
	principal: Pick<SessionPrincipal, "sessionId" | "actorId" | "organizationId">,
): Promise<void> {
	if (
		!(await lockLocalActor(client, principal.organizationId, principal.actorId))
	)
		throw new AuthenticationError();
	const result = await client.query(
		"SELECT session.id FROM local_sessions session JOIN local_credentials credential ON credential.organization_id = session.organization_id AND credential.actor_id = session.actor_id WHERE session.id = $1 AND session.organization_id = $2 AND session.actor_id = $3 AND session.revoked_at IS NULL AND session.expires_at > clock_timestamp() AND session.auth_version = credential.auth_version FOR SHARE OF session",
		[principal.sessionId, principal.organizationId, principal.actorId],
	);
	if (!result.rowCount) throw new AuthenticationError();
}

let dummyHash: Promise<PasswordHash> | undefined;
let activePasswordVerifications = 0;
function dummyPasswordHash() {
	return (dummyHash ??= hashLocalPassword(
		randomBytes(32).toString("base64url"),
	));
}

export class LocalSessionStore {
	constructor(
		readonly pool: Pool,
		readonly organizationId: string,
	) {}

	async audit(
		action:
			| "login_succeeded"
			| "login_failed"
			| "login_limited"
			| "session_revoked",
		actorId: string | null = null,
		db: Queryable = this.pool,
	) {
		await db.query(
			"INSERT INTO local_auth_audit_events (organization_id, actor_id, action) VALUES ($1, $2, $3)",
			[this.organizationId, actorId, action],
		);
		const fields = {
			organization_id: this.organizationId,
			...(actorId ? { actor_id: actorId } : {}),
		};
		if (action === "login_failed" || action === "login_limited")
			logger.warn(`auth.${action}`, fields);
		else logger.info(`auth.${action}`, fields);
	}

	async reserveAttempt(identifier: string): Promise<boolean> {
		const bucket = createHash("sha256")
			.update(identifier.toLowerCase())
			.digest()[0]!;
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			for (const [key, seconds, maximum] of [
				[-1, 60, 120],
				[bucket, 900, 5],
			]) {
				await client.query(
					"INSERT INTO local_login_limits (organization_id, bucket) VALUES ($1, $2) ON CONFLICT DO NOTHING",
					[this.organizationId, key],
				);
				const accepted = await client.query(
					"UPDATE local_login_limits SET attempts = CASE WHEN window_started_at + $3 * interval '1 second' <= clock_timestamp() THEN 1 ELSE attempts + 1 END, window_started_at = CASE WHEN window_started_at + $3 * interval '1 second' <= clock_timestamp() THEN clock_timestamp() ELSE window_started_at END WHERE organization_id = $1 AND bucket = $2 AND (attempts < $4 OR window_started_at + $3 * interval '1 second' <= clock_timestamp()) RETURNING bucket",
					[this.organizationId, key, seconds, maximum],
				);
				if (!accepted.rowCount) {
					await this.audit("login_limited", null, client);
					await client.query("COMMIT");
					return false;
				}
			}
			await client.query("COMMIT");
			return true;
		} catch (cause) {
			await client.query("ROLLBACK");
			throw cause;
		} finally {
			client.release();
		}
	}

	async login(
		username: string,
		password: string,
	): Promise<{ token: string; expiresAt: Date } | null> {
		if (!(await this.reserveAttempt(username))) return null;
		if (activePasswordVerifications >= 4) {
			await this.audit("login_limited");
			return null;
		}
		activePasswordVerifications++;
		try {
			return await this.admitLogin(username, password);
		} finally {
			activePasswordVerifications--;
		}
	}

	private async admitLogin(
		username: string,
		password: string,
	): Promise<{ token: string; expiresAt: Date } | null> {
		let normalized = "";
		try {
			normalized = normalizeLocalUsername(username);
		} catch {}
		const before = await this.pool.query<{
			actor_id: string;
			auth_version: string;
			ready: boolean;
		}>(
			"SELECT actor_id, auth_version, enabled AND password_hash IS NOT NULL AS ready FROM local_credentials WHERE organization_id = $1 AND username = $2",
			[this.organizationId, normalized],
		);
		const snapshot = before.rows[0];
		const principal = snapshot?.ready
			? await new LocalCredentialStore(
					this.pool,
					this.organizationId,
				).verifyForSession(username, password)
			: null;
		if (!snapshot?.ready)
			await verifyLocalPassword(password, await dummyPasswordHash());
		if (!principal) {
			await this.audit("login_failed");
			return null;
		}
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const credential = await client.query(
				"SELECT actor_id FROM local_credentials WHERE organization_id = $1 AND actor_id = $2 AND enabled AND password_hash IS NOT NULL AND auth_version = $3 FOR UPDATE",
				[this.organizationId, principal.actorId, principal.authVersion],
			);
			if (!credential.rowCount) {
				await this.audit("login_failed", null, client);
				await client.query("COMMIT");
				return null;
			}
			// Prune on successful admission and cap concurrent sessions per account.
			await client.query(
				"DELETE FROM local_sessions WHERE organization_id = $1 AND actor_id = $2 AND (revoked_at IS NOT NULL OR expires_at <= clock_timestamp())",
				[this.organizationId, principal.actorId],
			);
			await client.query(
				"UPDATE local_sessions SET revoked_at = clock_timestamp() WHERE id IN (SELECT id FROM local_sessions WHERE organization_id = $1 AND actor_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC, id DESC OFFSET 9)",
				[this.organizationId, principal.actorId],
			);
			const token = randomBytes(32).toString("base64url");
			const session = await client.query<{ expires_at: Date }>(
				"INSERT INTO local_sessions (organization_id, actor_id, token_digest, auth_version, created_at, expires_at) VALUES ($1, $2, $3, $4, statement_timestamp(), statement_timestamp() + interval '8 hours') RETURNING expires_at",
				[
					this.organizationId,
					principal.actorId,
					sessionDigest(token),
					principal.authVersion,
				],
			);
			await this.audit("login_succeeded", principal.actorId, client);
			// Do not invert the limiter's global-then-bucket lock order while
			// resetting an admitted account's failed-attempt window.
			await client.query(
				"SELECT bucket FROM local_login_limits WHERE organization_id = $1 AND bucket = -1 FOR UPDATE",
				[this.organizationId],
			);
			await client.query(
				"UPDATE local_login_limits SET attempts = 0 WHERE organization_id = $1 AND bucket = $2",
				[
					this.organizationId,
					createHash("sha256").update(username.toLowerCase()).digest()[0]!,
				],
			);
			await client.query("COMMIT");
			return { token, expiresAt: session.rows[0]!.expires_at };
		} catch (cause) {
			await client.query("ROLLBACK");
			throw cause;
		} finally {
			client.release();
		}
	}

	async authenticate(token: string): Promise<SessionPrincipal | null> {
		const digest = sessionDigest(token);
		if (!digest) return null;
		const result = await this.pool.query<SessionRow>(
			"SELECT session.id, session.organization_id, session.actor_id, session.expires_at FROM local_sessions session JOIN local_credentials credential ON credential.organization_id = session.organization_id AND credential.actor_id = session.actor_id JOIN actor_identities identity ON identity.organization_id = credential.organization_id AND identity.actor_id = credential.actor_id AND identity.provider_namespace = 'local:v1' AND identity.canonical_subject = credential.canonical_subject WHERE session.organization_id = $1 AND session.token_digest = $2 AND session.revoked_at IS NULL AND session.expires_at > clock_timestamp() AND credential.enabled AND credential.password_hash IS NOT NULL AND session.auth_version = credential.auth_version",
			[this.organizationId, digest],
		);
		const row = result.rows[0];
		return row
			? {
					actor: `actor:${row.actor_id}`,
					actorId: row.actor_id,
					organizationId: row.organization_id,
					sessionId: row.id,
				}
			: null;
	}

	async logout(principal: SessionPrincipal): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT actor_id FROM local_credentials WHERE organization_id = $1 AND actor_id = $2 FOR UPDATE",
				[principal.organizationId, principal.actorId],
			);
			await lockSessionPrincipal(client, principal);
			await client.query(
				"UPDATE local_sessions SET revoked_at = clock_timestamp() WHERE id = $1 AND organization_id = $2 AND actor_id = $3",
				[principal.sessionId, principal.organizationId, principal.actorId],
			);
			await this.audit("session_revoked", principal.actorId, client);
			await client.query("COMMIT");
		} catch (cause) {
			await client.query("ROLLBACK");
			throw cause;
		} finally {
			client.release();
		}
	}
}
