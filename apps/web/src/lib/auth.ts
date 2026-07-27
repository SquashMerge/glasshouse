const KEY_USERNAME = "astraea.auth.username";
const KEY_PASSWORD = "astraea.auth.password";

type Credentials = { username: string; password: string };

let credentials: Credentials | null = null;

function removePersistedCredentials(): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.removeItem(KEY_USERNAME);
		window.localStorage.removeItem(KEY_PASSWORD);
	} catch {
		// Ignore storage access errors and rely on the in-memory session.
	}
}

if (typeof window !== "undefined") removePersistedCredentials();

export function setCredentials(username: string, password: string): void {
	credentials = { username, password };
	removePersistedCredentials();
}

export function clearCredentials(): void {
	credentials = null;
	removePersistedCredentials();
}

export function getCredentials(): Credentials | null {
	if (typeof window === "undefined") return null;
	removePersistedCredentials();
	return credentials;
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
	const headers = new Headers(init?.headers);
	const auth = authHeader(creds);
	for (const [k, v] of Object.entries(auth)) headers.set(k, v);
	const res = await fetch(url, { ...init, headers });
	if (res.status === 401 && creds) {
		clearCredentials();
		if (typeof window !== "undefined") {
			window.dispatchEvent(new CustomEvent(AUTH_INVALID_EVENT));
		}
	}
	return res;
}
