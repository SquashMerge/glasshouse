const KEY_USERNAME = "astraea.auth.username";
const KEY_PASSWORD = "astraea.auth.password";

type Credentials = { username: string; password: string };

let credentials: Credentials | null = null;
let localSession: { username: string; csrfToken: string } | null = null;
let sessionGeneration = 0;

function removePersistedCredentials(): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.removeItem(KEY_USERNAME);
		window.localStorage.removeItem(KEY_PASSWORD);
	} catch {
		// Ignore storage access errors and rely on the current page session.
	}
}

function readSessionCredentials(): Credentials | null {
	if (typeof window === "undefined") return null;
	try {
		const username = window.sessionStorage.getItem(KEY_USERNAME);
		const password = window.sessionStorage.getItem(KEY_PASSWORD);
		return username && password ? { username, password } : null;
	} catch {
		return null;
	}
}

if (typeof window !== "undefined") removePersistedCredentials();

export function setCredentials(username: string, password: string): void {
	credentials = { username, password };
	try {
		window.sessionStorage.setItem(KEY_USERNAME, username);
		window.sessionStorage.setItem(KEY_PASSWORD, password);
	} catch {
		// Keep the credentials in memory if session storage is unavailable.
	}
	removePersistedCredentials();
}

export function clearCredentials(): void {
	credentials = null;
	localSession = null;
	sessionGeneration++;
	try {
		window.sessionStorage.removeItem(KEY_USERNAME);
		window.sessionStorage.removeItem(KEY_PASSWORD);
	} catch {
		// Ignore storage access errors and rely on the in-memory session.
	}
	removePersistedCredentials();
}

export function getCredentials(): Credentials | null {
	if (typeof window === "undefined") return null;
	if (localSession) return { username: localSession.username, password: "" };
	removePersistedCredentials();
	credentials ??= readSessionCredentials();
	return credentials;
}

export async function restoreLocalSession(
	username = "Account",
): Promise<boolean> {
	const generation = sessionGeneration;
	const response = await fetch("/v1/auth/session", {
		credentials: "same-origin",
	});
	if (generation !== sessionGeneration) return localSession !== null;
	if (!response.ok) return false;
	const session = await response.json();
	if (generation !== sessionGeneration) return localSession !== null;
	if (
		session.authentication !== "local_session" ||
		typeof session.csrf_token !== "string" ||
		!session.csrf_token
	)
		return false;
	clearCredentials();
	localSession = { username, csrfToken: session.csrf_token };
	return true;
}

export async function logoutSession(): Promise<void> {
	const response = await authedFetch("/v1/auth/logout", { method: "POST" });
	if (!response.ok) throw new Error("Sign out failed");
	clearCredentials();
}

export function authHeader(creds: Credentials | null): Record<string, string> {
	if (!creds) return {};
	const token = btoa(`${creds.username}:${creds.password}`);
	return { authorization: `Basic ${token}` };
}

const AUTH_INVALID_EVENT = "astraea:auth-invalid";

export function onAuthInvalid(handler: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	window.addEventListener(AUTH_INVALID_EVENT, handler);
	return () => window.removeEventListener(AUTH_INVALID_EVENT, handler);
}

export async function authedFetch(
	url: string,
	init?: RequestInit,
): Promise<Response> {
	const creds = getCredentials();
	const generation = sessionGeneration;
	const headers = new Headers(init?.headers);
	const auth = localSession ? {} : authHeader(creds);
	for (const [k, v] of Object.entries(auth)) headers.set(k, v);
	if (localSession) {
		headers.delete("authorization");
		if (
			!["GET", "HEAD", "OPTIONS"].includes(
				(init?.method ?? "GET").toUpperCase(),
			)
		)
			headers.set("x-astraea-csrf", localSession.csrfToken);
	}
	const res = await fetch(url, {
		...init,
		headers,
		credentials: "same-origin",
	});
	if (res.status === 401 && creds && generation === sessionGeneration) {
		clearCredentials();
		if (typeof window !== "undefined") {
			window.dispatchEvent(new CustomEvent(AUTH_INVALID_EVENT));
		}
	}
	return res;
}
