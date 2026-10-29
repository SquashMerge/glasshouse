import { createHash, timingSafeEqual } from "node:crypto";
import { authenticateOtlpCredential } from "../db/otlp-credentials.js";
import {
	BASIC_AUTH_PROVIDER_NAMESPACE,
	deterministicActorId,
} from "../db/actors.js";
import type { MiddlewareHandler } from "hono";
import type { Pool } from "pg";
import { authenticationPool, pgPool } from "../db/postgres.js";
import {
	AuthenticationError,
	CSRF_HEADER,
	SESSION_COOKIE,
	LocalSessionStore,
	lockLocalActor,
	lockSessionPrincipal,
	validSessionCsrf,
} from "../db/local-sessions.js";

export { BASIC_AUTH_PROVIDER_NAMESPACE };

export const TRUSTED_ACTOR_CONTEXT_KEY = "trustedActor";
export const TRUSTED_TENANT_CONTEXT_KEY = "trustedTenant";

export const DEFAULT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

export type TrustedTenantContext = {
	actor: string;
	actorId: string;
	organizationId: string;
	sessionId?: string;
	ingestCredential?: {
		id: string;
		projectId: string;
		digest: string;
	};
};

export type BasicCredential = {
	username: string;
	password: string;
	organizationId: string;
	canonicalSubject: string;
	actorId: string;
};

export function canonicalBasicAuthSubject(subject: string): string {
	const canonical = subject.normalize("NFKC").trim().toLowerCase();
	if (!canonical || !/^[ -~]+$/.test(canonical))
		throw new Error(
			"basicAuthMiddleware: Basic Auth usernames must normalize to printable ASCII",
		);
	return canonical;
}

export function durableActorId(canonicalSubject: string): string {
	return deterministicActorId(BASIC_AUTH_PROVIDER_NAMESPACE, canonicalSubject);
}

function constantTimeEqual(a: string, b: string): boolean {
	const A = new TextEncoder().encode(a);
	const B = new TextEncoder().encode(b);
	if (A.length !== B.length) {
		const pad = new Uint8Array(A.length);
		timingSafeEqual(pad, pad);
		return false;
	}
	return timingSafeEqual(A, B);
}

function parseBasic(
	header: string | undefined,
): { user: string; pass: string } | null {
	if (!header || header.length > 8192) return null;
	const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/.exec(header);
	if (!m) return null;
	let decoded: string;
	try {
		decoded = Buffer.from(m[1]!, "base64").toString("utf8");
	} catch {
		return null;
	}
	const sep = decoded.indexOf(":");
	if (sep < 0) return null;
	return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

function isUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value,
		)
	);
}

function validCredential(value: unknown): value is {
	username: string;
	password: string;
	organization_id: string;
} {
	if (!value || typeof value !== "object") return false;
	const credential = value as Record<string, unknown>;
	return (
		typeof credential.username === "string" &&
		credential.username.length > 0 &&
		typeof credential.password === "string" &&
		credential.password.length > 0 &&
		isUuid(credential.organization_id)
	);
}

export function basicCredentialsFromEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): BasicCredential[] {
	const configured = env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS;
	if (configured) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(configured);
		} catch {
			throw new Error(
				"basicAuthMiddleware: GLASSHOUSE_BASIC_AUTH_CREDENTIALS must be valid JSON",
			);
		}
		if (
			!Array.isArray(parsed) ||
			parsed.length === 0 ||
			!parsed.every(validCredential)
		) {
			throw new Error(
				"basicAuthMiddleware: GLASSHOUSE_BASIC_AUTH_CREDENTIALS must be a non-empty array of { username, password, organization_id UUID } credentials",
			);
		}
		const subjects = new Set<string>();
		for (const credential of parsed) {
			const canonicalSubject = canonicalBasicAuthSubject(credential.username);
			if (subjects.has(canonicalSubject)) {
				throw new Error(
					"basicAuthMiddleware: GLASSHOUSE_BASIC_AUTH_CREDENTIALS canonical usernames must be unique",
				);
			}
			subjects.add(canonicalSubject);
		}
		return parsed.map((credential) => ({
			username: credential.username,
			password: credential.password,
			organizationId: credential.organization_id,
			canonicalSubject: canonicalBasicAuthSubject(credential.username),
			actorId: durableActorId(canonicalBasicAuthSubject(credential.username)),
		}));
	}

	const username = env.UI_USERNAME;
	const password = env.UI_PASSWORD;
	if (!username || !password) {
		throw new Error(
			"basicAuthMiddleware: UI_USERNAME and UI_PASSWORD must be set in the environment",
		);
	}
	const organizationId =
		env.GLASSHOUSE_DEFAULT_ORGANIZATION_ID ?? DEFAULT_ORGANIZATION_ID;
	if (!isUuid(organizationId)) {
		throw new Error(
			"basicAuthMiddleware: GLASSHOUSE_DEFAULT_ORGANIZATION_ID must be a UUID",
		);
	}
	const canonicalSubject = canonicalBasicAuthSubject(username);
	return [
		{
			username,
			password,
			organizationId,
			canonicalSubject,
			actorId: durableActorId(canonicalSubject),
		},
	];
}

export function verifiedCredential(
	credentials: BasicCredential[],
	got: { user: string; pass: string } | null,
): BasicCredential | null {
	if (!got) return null;
	let verified: BasicCredential | null = null;
	for (const credential of credentials) {
		const usernameMatches = constantTimeEqual(got.user, credential.username);
		const passwordMatches = constantTimeEqual(got.pass, credential.password);
		if (usernameMatches && passwordMatches) verified = credential;
	}
	return verified;
}

export function basicAuthMiddleware(): MiddlewareHandler {
	const credentials = basicCredentialsFromEnvironment();

	return async (c, next) => {
		const credential = verifiedCredential(
			credentials,
			parseBasic(c.req.header("authorization")),
		);
		if (!credential) {
			c.header("WWW-Authenticate", 'Basic realm="glasshouse", charset="UTF-8"');
			return c.json(
				{ code: "UNAUTHORIZED", message: "Authentication required" },
				401,
			);
		}
		c.set(TRUSTED_ACTOR_CONTEXT_KEY, credential.username);
		c.set(TRUSTED_TENANT_CONTEXT_KEY, {
			actor: credential.username,
			actorId: credential.actorId,
			organizationId: credential.organizationId,
		} satisfies TrustedTenantContext);
		await next();
	};
}

export const PUBLIC_API_ROUTES = new Set([
	"GET /health",
	"HEAD /health",
	"GET /v1/health",
	"HEAD /v1/health",
	"GET /v1/auth/setup",
	"POST /v1/auth/setup",
	"POST /v1/auth/login",
	"POST /v1/auth/invitations/accept",
]);
export const AUTH_SESSION_TOKEN_CONTEXT_KEY = "authSessionToken";

export function ownsAuthenticationFence(method: string, path: string): boolean {
	return (
		(method === "POST" &&
			[
				"/v1/auth/logout",
				"/v1/auth/password",
				"/v1/admin/local-accounts",
			].includes(path)) ||
		(method === "PUT" &&
			/^\/v1\/admin\/(?:local-accounts\/[^/]+\/status|actors\/[^/]+\/role)$/.test(
				path,
			)) ||
		(method === "POST" &&
			/^\/v1\/admin\/local-accounts\/[^/]+\/reset$/.test(path)) ||
		(method === "DELETE" &&
			/^\/v1\/admin\/local-enrollments\/[^/]+$/.test(path))
	);
}

export function requestSessionToken(
	header: string | undefined,
): string | undefined {
	if (!header) return undefined;
	if (header.length > 8192) return "";
	const values = header
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.split("=", 1)[0] === SESSION_COOKIE);
	if (!values.length) return undefined;
	if (values.length !== 1) return "";
	return values[0]!.slice(SESSION_COOKIE.length + 1);
}

export function localAuthOrganization(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const id = env.GLASSHOUSE_DEFAULT_ORGANIZATION_ID ?? DEFAULT_ORGANIZATION_ID;
	if (!isUuid(id)) throw new Error("Invalid local authentication organization");
	return id;
}

export function configuredBasicCredentials(): BasicCredential[] {
	if (
		process.env.GLASSHOUSE_AUTH_BOOTSTRAP_MODE === "local" &&
		!process.env.GLASSHOUSE_BASIC_AUTH_CREDENTIALS &&
		!process.env.UI_USERNAME &&
		!process.env.UI_PASSWORD
	)
		return [];
	return basicCredentialsFromEnvironment();
}

export function verifyBasicHeader(
	header: string | undefined,
	credentials = configuredBasicCredentials(),
): BasicCredential | null {
	return verifiedCredential(credentials, parseBasic(header));
}

export function trustedRequestOrigin(c: {
	req: { url: string; header: (name: string) => string | undefined };
}): boolean {
	const expected =
		process.env.GLASSHOUSE_PUBLIC_ORIGIN || new URL(c.req.url).origin;
	const origin = c.req.header("origin");
	return (
		(!origin || origin === expected) &&
		!["cross-site", "same-site"].includes(c.req.header("sec-fetch-site") ?? "")
	);
}

export async function basicIdentityAvailable(
	pool: Pick<Pool, "query">,
	credential: BasicCredential,
): Promise<boolean> {
	const identity = await pool.query(
		"SELECT 1 FROM actor_identities WHERE organization_id = $1 AND actor_id = $2 AND provider_namespace = 'basic:v1' AND canonical_subject = $3 AND local_actor_authentication_enabled($1, $2)",
		[
			credential.organizationId,
			credential.actorId,
			credential.canonicalSubject,
		],
	);
	return !!identity.rowCount;
}

export function authenticationMiddleware(
	pool: () => Pool = pgPool,
	fencePool: () => Pool = authenticationPool,
): MiddlewareHandler {
	const credentials = configuredBasicCredentials();
	const organizationId = localAuthOrganization();
	return async (c, next) => {
		c.header("Cache-Control", "no-store");
		if (PUBLIC_API_ROUTES.has(`${c.req.method} ${c.req.path}`))
			return await next();
		const store = new LocalSessionStore(pool(), organizationId);
		const token = requestSessionToken(c.req.header("cookie"));
		let principal: TrustedTenantContext | null = null;
		// A presented cookie wins, including invalid cookies. Never fall back to
		// Basic or let a supplied header suppress a cookie's CSRF requirement.
		if (token !== undefined) principal = await store.authenticate(token);
		else {
			const basicCredential = verifyBasicHeader(
				c.req.header("authorization"),
				credentials,
			);
			if (
				basicCredential &&
				(await basicIdentityAvailable(pool(), basicCredential))
			)
				principal = {
					actor: basicCredential.username,
					actorId: basicCredential.actorId,
					organizationId: basicCredential.organizationId,
				};
			else if (c.req.method === "POST" && c.req.path === "/v1/otel/v1/traces") {
				const header = c.req.header("authorization");
				const match =
					header && header.length <= 256
						? /^Bearer (gh_ing_[A-Za-z0-9_-]{43})$/.exec(header)
						: null;
				if (match) {
					const ingestCredential = await authenticateOtlpCredential(
						pool(),
						match[1]!,
					);
					if (ingestCredential) {
						principal = {
							actor: ingestCredential.actorId,
							actorId: ingestCredential.actorId,
							organizationId: ingestCredential.organizationId,
							ingestCredential: {
								id: ingestCredential.id,
								projectId: ingestCredential.projectId,
								digest: createHash("sha256")
									.update(match[1]!, "utf8")
									.digest("hex"),
							},
						};
					}
				}
			}
		}
		if (!principal) {
			c.header("WWW-Authenticate", 'Basic realm="glasshouse", charset="UTF-8"');
			return c.json(
				{ code: "UNAUTHORIZED", message: "Authentication required" },
				401,
			);
		}
		if (
			token !== undefined &&
			!["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
			(!trustedRequestOrigin(c) ||
				!validSessionCsrf(token, c.req.header(CSRF_HEADER)))
		)
			return c.json(
				{ code: "FORBIDDEN", message: "Request origin verification failed" },
				403,
			);
		c.set(TRUSTED_ACTOR_CONTEXT_KEY, principal.actor);
		c.set(TRUSTED_TENANT_CONTEXT_KEY, principal);
		if (token !== undefined) c.set(AUTH_SESSION_TOKEN_CONTEXT_KEY, token);
		c.header("Cache-Control", "no-store");
		// Auth-control routes revalidate under their own mutation transaction.
		// SSE releases the initial fence; every delivered frame acquires its own.
		if (
			ownsAuthenticationFence(c.req.method, c.req.path) ||
			c.req.path.endsWith("/events")
		)
			return await next();
		const client = await fencePool().connect();
		try {
			await client.query("BEGIN");
			if (principal.sessionId)
				await lockSessionPrincipal(
					client,
					principal as import("../db/local-sessions.js").SessionPrincipal,
				);
			else if (
				!(await lockLocalActor(
					client,
					principal.organizationId,
					principal.actorId,
				))
			)
				throw new AuthenticationError();
			await next();
			await client.query("COMMIT");
		} catch (cause) {
			await client.query("ROLLBACK");
			if (cause instanceof AuthenticationError)
				return c.json(
					{ code: "UNAUTHORIZED", message: "Authentication required" },
					401,
				);
			throw cause;
		} finally {
			client.release();
		}
	};
}
