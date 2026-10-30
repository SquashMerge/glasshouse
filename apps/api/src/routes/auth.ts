import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { ErrorEnvelope } from "../schemas/common.js";
import { pgPool } from "../db/postgres.js";
import { LocalCredentialStore } from "../db/local-credentials.js";
import {
	CSRF_HEADER,
	SESSION_COOKIE,
	SESSION_LIFETIME_SECONDS,
	LocalSessionStore,
	csrfForSession,
	lockSessionPrincipal,
	type SessionPrincipal,
} from "../db/local-sessions.js";
import {
	hashLocalPassword,
	validLocalPassword,
	validNewLocalPassword,
	verifyLocalPassword,
	type PasswordHash,
} from "../lib/local-passwords.js";
import {
	AUTH_SESSION_TOKEN_CONTEXT_KEY,
	basicIdentityAvailable,
	localAuthOrganization,
	trustedRequestOrigin,
	verifyBasicHeader,
} from "../middleware/auth.js";
import { trustedTenant } from "../tenancy.js";

const tag = "auth";
const password = z
	.string()
	.min(1)
	.max(1024)
	.refine(validLocalPassword)
	.openapi({ writeOnly: true });
const newPassword = z
	.string()
	.refine(validNewLocalPassword, {
		message:
			"Use at least 12 characters and choose a shorter password if it is too long.",
	})
	.openapi({
		writeOnly: true,
		minLength: 12,
		description:
			"At least 12 Unicode code points and no more than 1024 UTF-8 bytes.",
	});
const secret = z.string().length(43).openapi({ writeOnly: true });
const ok = z.object({ ok: z.literal(true) });
const responses = {
	200: {
		description: "Operation accepted",
		content: { "application/json": { schema: ok } },
	},
	401: {
		description: "Authentication failed (including lockout)",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
	403: {
		description: "Origin or CSRF verification failed",
		content: { "application/json": { schema: ErrorEnvelope } },
	},
};
export const loginRoute = createRoute({
	method: "post",
	path: "/v1/auth/login",
	tags: [tag],
	summary: "Sign in to Glasshouse",
	description:
		"Verify a deployment-scoped local username/password and set an HttpOnly session cookie. No token is returned. Basic-header-only prevalidation remains available for compatibility; it does not issue a local session. Failures are uniform, including bounded login lockout. Never send an organization, role, or actor claim.",
	security: [],
	request: {
		body: {
			required: false,
			content: {
				"application/json": {
					schema: z.union([
						z
							.object({ username: z.string().min(1).max(64), password })
							.strict(),
						z.object({}).strict(),
					]),
				},
			},
		},
	},
	responses,
});
export const currentSessionRoute = createRoute({
	method: "get",
	path: "/v1/auth/session",
	tags: [tag],
	summary: "Read the authenticated session",
	security: [{ sessionCookie: [] }, { basicAuth: [] }],
	responses: {
		200: {
			description: "Trusted session context; CSRF value is not a bearer token",
			content: {
				"application/json": {
					schema: z.object({
						actor_id: z.string().uuid(),
						organization_id: z.string().uuid(),
						authentication: z.enum(["local_session", "basic"]),
						expires_at: z.string().datetime().nullable(),
						csrf_token: z.string().nullable(),
						username: z.string().nullable(),
					}),
				},
			},
		},
		401: responses[401],
	},
});
export const logoutRoute = createRoute({
	method: "post",
	path: "/v1/auth/logout",
	tags: [tag],
	summary: "Revoke the current local session",
	security: [{ sessionCookie: [], csrfHeader: [] }, { basicAuth: [] }],
	responses,
});
export const changePasswordRoute = createRoute({
	method: "post",
	path: "/v1/auth/password",
	tags: [tag],
	summary: "Change own local password and revoke all sessions",
	security: [{ sessionCookie: [], csrfHeader: [] }],
	request: {
		body: {
			required: true,
			content: {
				"application/json": {
					schema: z
						.object({ current_password: password, new_password: newPassword })
						.strict(),
				},
			},
		},
	},
	responses: {
		...responses,
		422: {
			description: "Current password was not accepted",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
		429: {
			description: "Password change attempts are temporarily limited",
			content: { "application/json": { schema: ErrorEnvelope } },
		},
	},
});
export const setupStateRoute = createRoute({
	method: "get",
	path: "/v1/auth/setup",
	tags: [tag],
	summary: "Read first-Admin setup availability",
	security: [],
	responses: {
		200: {
			description: "Content-free availability only",
			content: {
				"application/json": { schema: z.object({ available: z.boolean() }) },
			},
		},
	},
});
export const setupRoute = createRoute({
	method: "post",
	path: "/v1/auth/setup",
	tags: [tag],
	summary: "Consume the operator's first-Admin setup token",
	security: [],
	request: {
		body: {
			required: true,
			content: {
				"application/json": {
					schema: z
						.object({
							username: z.string().min(3).max(64),
							password: newPassword,
							token: secret,
						})
						.strict(),
				},
			},
		},
	},
	responses,
});
export const acceptInvitationRoute = createRoute({
	method: "post",
	path: "/v1/auth/invitations/accept",
	tags: [tag],
	summary: "Set a first password using a single-use enrollment token",
	security: [],
	request: {
		body: {
			required: true,
			content: {
				"application/json": {
					schema: z.object({ token: secret, password: newPassword }).strict(),
				},
			},
		},
	},
	responses,
});

function store() {
	return new LocalSessionStore(pgPool(), localAuthOrganization());
}
function failed(c: Context) {
	return c.json(
		{ code: "UNAUTHORIZED", message: "Authentication required" },
		401,
	);
}
function originRejected(c: Context) {
	return c.json(
		{ code: "FORBIDDEN", message: "Request origin verification failed" },
		403,
	);
}
function cookie(c: Context, value: string, expires?: Date) {
	setCookie(c, SESSION_COOKIE, value, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "Strict",
		path: "/v1",
		maxAge: expires ? SESSION_LIFETIME_SECONDS : 0,
		expires: expires ?? new Date(0),
	});
}
export async function handleLogin(c: Context): Promise<Response> {
	c.header("Cache-Control", "no-store");
	if (!trustedRequestOrigin(c)) return originRejected(c);
	const input = (c.req as any).valid("json") as
		| { username: string; password: string }
		| undefined;
	if (!input?.username) {
		const credential = verifyBasicHeader(c.req.header("authorization"));
		if (!(await store().reserveAttempt("basic-login"))) return failed(c);
		if (!credential || !(await basicIdentityAvailable(pgPool(), credential))) {
			await store().audit("login_failed");
			return failed(c);
		}
		return c.json({ ok: true }, 200);
	}
	const session = await store().login(input.username, input.password);
	if (!session) return failed(c);
	cookie(c, session.token, session.expiresAt);
	return c.json({ ok: true }, 200);
}
export async function handleCurrentSession(c: Context): Promise<Response> {
	const tenant = trustedTenant(c);
	const token = c.get(AUTH_SESSION_TOKEN_CONTEXT_KEY) as string | undefined;
	if (!tenant.sessionId || !token)
		return c.json({
			actor_id: tenant.actorId,
			organization_id: tenant.organizationId,
			authentication: "basic",
			expires_at: null,
			csrf_token: null,
			username: null,
		});
	const session = await pgPool().query<{ expires_at: Date; username: string }>(
		"SELECT session.expires_at, credential.username FROM local_sessions session JOIN local_credentials credential ON credential.organization_id = session.organization_id AND credential.actor_id = session.actor_id WHERE session.id = $1 AND session.organization_id = $2 AND session.actor_id = $3 AND session.revoked_at IS NULL AND session.expires_at > clock_timestamp()",
		[tenant.sessionId, tenant.organizationId, tenant.actorId],
	);
	if (!session.rows[0]) return failed(c);
	return c.json({
		actor_id: tenant.actorId,
		organization_id: tenant.organizationId,
		authentication: "local_session",
		expires_at: session.rows[0].expires_at.toISOString(),
		csrf_token: csrfForSession(token),
		username: session.rows[0].username,
	});
}
export async function handleLogout(c: Context): Promise<Response> {
	const tenant = trustedTenant(c);
	if (tenant.sessionId) await store().logout(tenant as SessionPrincipal);
	cookie(c, "");
	return c.json({ ok: true });
}
export async function handleChangePassword(c: Context): Promise<Response> {
	const tenant = trustedTenant(c);
	if (!tenant.sessionId) return failed(c);
	const sessionStore = store();
	if (!(await sessionStore.reserveAttempt(tenant.actorId)))
		return c.json(
			{ code: "TOO_MANY_REQUESTS", message: "Too many attempts" },
			429,
		);
	const input = (c.req as any).valid("json") as {
		current_password: string;
		new_password: string;
	};
	const account = await pgPool().query<PasswordHash & { auth_version: string }>(
		"SELECT password_hash, password_algorithm, password_version, auth_version FROM local_credentials WHERE organization_id = $1 AND actor_id = $2 AND enabled AND password_hash IS NOT NULL",
		[tenant.organizationId, tenant.actorId],
	);
	if (!account.rows[0]) return failed(c);
	const verified = await verifyLocalPassword(
		input.current_password,
		account.rows[0],
	);
	if (!verified.verified)
		return c.json(
			{
				code: "INVALID_CURRENT_PASSWORD",
				message: "Current password is incorrect",
			},
			422,
		);
	const hash = await hashLocalPassword(input.new_password);
	const client = await pgPool().connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT actor_id FROM local_credentials WHERE organization_id = $1 AND actor_id = $2 FOR UPDATE",
			[tenant.organizationId, tenant.actorId],
		);
		await lockSessionPrincipal(client, tenant as SessionPrincipal);
		const updated = await client.query(
			"UPDATE local_credentials SET password_hash = $3, password_algorithm = $4, password_version = $5, updated_at = now() WHERE organization_id = $1 AND actor_id = $2 AND auth_version = $6 AND enabled RETURNING actor_id",
			[
				tenant.organizationId,
				tenant.actorId,
				hash.password_hash,
				hash.password_algorithm,
				hash.password_version,
				account.rows[0].auth_version,
			],
		);
		if (!updated.rowCount) {
			await client.query("ROLLBACK");
			return failed(c);
		}
		await client.query("COMMIT");
	} catch (cause) {
		await client.query("ROLLBACK");
		throw cause;
	} finally {
		client.release();
	}
	cookie(c, "");
	return c.json({ ok: true });
}
export async function handleSetupState(c: Context): Promise<Response> {
	c.header("Cache-Control", "no-store");
	const result = await pgPool().query<{ available: boolean }>(
		"SELECT closed_at IS NULL AND token_digest IS NOT NULL AND expires_at > clock_timestamp() AS available FROM local_bootstrap_controls WHERE organization_id = $1",
		[localAuthOrganization()],
	);
	return c.json({ available: result.rows[0]?.available ?? false });
}
export async function handleSetup(c: Context): Promise<Response> {
	c.header("Cache-Control", "no-store");
	if (!trustedRequestOrigin(c)) return originRejected(c);
	if (!(await store().reserveAttempt("setup"))) return failed(c);
	try {
		await new LocalCredentialStore(pgPool(), localAuthOrganization()).bootstrap(
			(c.req as any).valid("json"),
		);
		return c.json({ ok: true });
	} catch {
		return failed(c);
	}
}
export async function handleAcceptInvitation(c: Context): Promise<Response> {
	c.header("Cache-Control", "no-store");
	if (!trustedRequestOrigin(c)) return originRejected(c);
	if (!(await store().reserveAttempt("invitation"))) return failed(c);
	const input = (c.req as any).valid("json");
	try {
		await new LocalCredentialStore(pgPool(), localAuthOrganization()).enroll(
			input.token,
			input.password,
		);
		return c.json({ ok: true });
	} catch {
		return failed(c);
	}
}

export const authRoutes = [
	[loginRoute, handleLogin],
	[currentSessionRoute, handleCurrentSession],
	[logoutRoute, handleLogout],
	[changePasswordRoute, handleChangePassword],
	[setupStateRoute, handleSetupState],
	[setupRoute, handleSetup],
	[acceptInvitationRoute, handleAcceptInvitation],
] as const;
export { CSRF_HEADER };
