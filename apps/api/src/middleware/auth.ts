import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export const TRUSTED_ACTOR_CONTEXT_KEY = "trustedActor";
export const TRUSTED_TENANT_CONTEXT_KEY = "trustedTenant";

export const DEFAULT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
export const BASIC_AUTH_PROVIDER_NAMESPACE = "basic:v1";

export type TrustedTenantContext = {
	actor: string;
	actorId: string;
	organizationId: string;
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
	const hash = createHash("md5")
		.update(`${BASIC_AUTH_PROVIDER_NAMESPACE}:${canonicalSubject}`)
		.digest("hex");
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
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
	const configured = env.ASTRAEA_BASIC_AUTH_CREDENTIALS;
	if (configured) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(configured);
		} catch {
			throw new Error(
				"basicAuthMiddleware: ASTRAEA_BASIC_AUTH_CREDENTIALS must be valid JSON",
			);
		}
		if (
			!Array.isArray(parsed) ||
			parsed.length === 0 ||
			!parsed.every(validCredential)
		) {
			throw new Error(
				"basicAuthMiddleware: ASTRAEA_BASIC_AUTH_CREDENTIALS must be a non-empty array of { username, password, organization_id UUID } credentials",
			);
		}
		const subjects = new Set<string>();
		for (const credential of parsed) {
			const canonicalSubject = canonicalBasicAuthSubject(credential.username);
			if (subjects.has(canonicalSubject)) {
				throw new Error(
					"basicAuthMiddleware: ASTRAEA_BASIC_AUTH_CREDENTIALS canonical usernames must be unique",
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
		env.ASTRAEA_DEFAULT_ORGANIZATION_ID ?? DEFAULT_ORGANIZATION_ID;
	if (!isUuid(organizationId)) {
		throw new Error(
			"basicAuthMiddleware: ASTRAEA_DEFAULT_ORGANIZATION_ID must be a UUID",
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

function verifiedCredential(
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
			c.header("WWW-Authenticate", 'Basic realm="astraea", charset="UTF-8"');
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
