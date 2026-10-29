export type AuthSession = {
	actor_id: string;
	organization_id: string;
	authentication: "local_session" | "basic";
	expires_at: string | null;
	csrf_token: string | null;
	username: string | null;
};

let session: AuthSession | null = null;
let loading: Promise<AuthSession | null> | null = null;
let generation = 0;
let expired = false;
const AUTH_INVALID_EVENT = "glasshouse:auth-invalid";
const AUTH_INVALID_STORAGE_KEY = "glasshouse.auth.invalidate";

export function invalidateOtherAuthTabs(): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(AUTH_INVALID_STORAGE_KEY, crypto.randomUUID());
	} catch {
		// AuthGate also revalidates on focus when storage is unavailable.
	}
}

if (typeof window !== "undefined") {
	window.addEventListener("storage", (event) => {
		if (event.key === AUTH_INVALID_STORAGE_KEY && event.newValue)
			expireAuthSession(false);
	});
}

function removeLegacyCredentials(): void {
	if (typeof window === "undefined") return;
	for (const name of ["localStorage", "sessionStorage"] as const) {
		try {
			for (const key of [
				"glasshouse.auth.username",
				"glasshouse.auth.password",
			])
				window[name].removeItem(key);
		} catch {
			// Storage is optional; authentication uses only the server cookie.
		}
	}
}
removeLegacyCredentials();

export function clearAuthSession(): void {
	generation++;
	session = null;
	loading = null;
	expired = false;
	removeLegacyCredentials();
}
export function getAuthSession(): AuthSession | null {
	return session;
}
export function sessionNeedsSignIn(): boolean {
	return expired;
}
export function refreshAuthSession(): Promise<AuthSession | null> {
	// Preserve the cached identity while fencing every older in-flight response.
	generation++;
	loading = null;
	return readAuthSession();
}
export async function readAuthSession(): Promise<AuthSession | null> {
	removeLegacyCredentials();
	if (loading) return loading;
	const started = generation;
	const request = (async () => {
		const response = await fetch("/v1/auth/session", {
			credentials: "same-origin",
			cache: "no-store",
		});
		if (response.status !== 401 && !response.ok)
			throw new Error("Session could not be checked");
		const value = response.ok ? ((await response.json()) as AuthSession) : null;
		if (started !== generation) return null;
		if (
			value?.authentication === "local_session" &&
			(typeof value.csrf_token !== "string" || !value.csrf_token)
		)
			throw new Error("Session could not be checked");
		session = value;
		return value;
	})();
	loading = request;
	try {
		return await request;
	} finally {
		if (loading === request) loading = null;
	}
}
export function onAuthInvalid(handler: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	window.addEventListener(AUTH_INVALID_EVENT, handler);
	return () => window.removeEventListener(AUTH_INVALID_EVENT, handler);
}
export function expireAuthSession(broadcast = true) {
	clearAuthSession();
	expired = true;
	if (broadcast) invalidateOtherAuthTabs();
	if (typeof window !== "undefined")
		window.dispatchEvent(new CustomEvent(AUTH_INVALID_EVENT));
}

export async function authedFetch(
	url: string,
	init?: RequestInit,
): Promise<Response> {
	const target = new URL(url, window.location.origin);
	if (
		target.origin !== window.location.origin ||
		!target.pathname.startsWith("/v1/")
	)
		throw new Error("Authenticated requests require the same-origin API");
	const method = (init?.method ?? "GET").toUpperCase();
	const headers = new Headers(init?.headers);
	headers.delete("authorization");
	if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
		if (session?.csrf_token)
			headers.set("x-glasshouse-csrf", session.csrf_token);
	}
	const started = generation;
	const response = await fetch(url, {
		...init,
		credentials: "same-origin",
		headers,
	});
	if (response.status === 401 && started === generation) expireAuthSession();
	return response;
}

export async function logoutSession(): Promise<void> {
	const response = await authedFetch("/v1/auth/logout", { method: "POST" });
	if (!response.ok && response.status !== 401)
		throw new Error("Logout could not be completed. Please retry.");
	expireAuthSession();
}
