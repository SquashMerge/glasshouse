import { readFile } from "node:fs/promises";

export async function setupE2eLocalAuth(input: {
	apiBase: string;
	origin: string;
	username: string;
	password: string;
	token: string;
}) {
	async function available() {
		const response = await fetch(`${input.apiBase}/v1/auth/setup`);
		if (response.status !== 200) throw new Error("E2E setup state failed");
		return (await response.json()).available;
	}
	async function setup() {
		return fetch(`${input.apiBase}/v1/auth/setup`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: input.origin },
			body: JSON.stringify({
				username: input.username,
				password: input.password,
				token: input.token,
			}),
		});
	}
	if ((await available()) !== true) throw new Error("E2E setup must be open");
	const created = await setup();
	if (created.status !== 200 || created.headers.has("set-cookie"))
		throw new Error("E2E first-Admin setup failed");
	if (JSON.stringify(await created.json()) !== '{"ok":true}')
		throw new Error("E2E setup returned unexpected fields");
	if ((await available()) !== false) throw new Error("E2E setup must close");
	const replay = await setup();
	if (replay.status !== 401 || replay.headers.has("set-cookie"))
		throw new Error("E2E setup token replay must fail");
}

if (import.meta.main) {
	try {
		const env = process.env;
		if (
			env.ASTRAEA_AUTH_BOOTSTRAP_MODE !== "local" ||
			!env.ASTRAEA_LOCAL_BOOTSTRAP_TOKEN_FILE ||
			!env.E2E_LOCAL_USERNAME ||
			!env.E2E_LOCAL_PASSWORD ||
			!env.ASTRAEA_PUBLIC_ORIGIN
		)
			throw new Error("Missing E2E local setup configuration");
		await setupE2eLocalAuth({
			apiBase: env.E2E_API_BASE ?? "http://localhost:3000",
			origin: env.ASTRAEA_PUBLIC_ORIGIN,
			username: env.E2E_LOCAL_USERNAME,
			password: env.E2E_LOCAL_PASSWORD,
			token: (
				await readFile(env.ASTRAEA_LOCAL_BOOTSTRAP_TOKEN_FILE, "utf8")
			).trim(),
		});
	} catch {
		// Fetch errors can include request details; never print the underlying cause.
		process.stderr.write("E2E local Admin setup rejected\n");
		process.exitCode = 1;
	}
}
