const KEY_USERNAME = "astraea.auth.username";
const KEY_PASSWORD = "astraea.auth.password";

export function setCredentials(username: string, password: string): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(KEY_USERNAME, username);
	window.localStorage.setItem(KEY_PASSWORD, password);
}

export function clearCredentials(): void {
	if (typeof window === "undefined") return;
	window.localStorage.removeItem(KEY_USERNAME);
	window.localStorage.removeItem(KEY_PASSWORD);
}

export function getCredentials(): {
	username: string;
	password: string;
} | null {
	if (typeof window === "undefined") return null;
	const u = window.localStorage.getItem(KEY_USERNAME);
	const p = window.localStorage.getItem(KEY_PASSWORD);
	if (!u || !p) return null;
	return { username: u, password: p };
}

export function authHeader(
	creds: { username: string; password: string } | null,
): Record<string, string> {
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
