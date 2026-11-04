import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { chromium, expect } from "@playwright/test";

const upstream = process.env.CANDIDATE_URL;
const key = process.env.CANDIDATE_TLS_KEY;
const cert = process.env.CANDIDATE_TLS_CERT;
if (
	!upstream ||
	!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(upstream) ||
	!key ||
	!cert
)
	throw new Error("A loopback candidate URL and test TLS files are required");
const origin = "https://127.0.0.1:34443";
const foreignProject = "d0000000-0000-4000-8000-000000000002";
// Exercise real Secure cookies and the configured origin through a TLS proxy.
const proxy = createServer(
	{ key: readFileSync(key), cert: readFileSync(cert) },
	(req, res) => {
		const outgoing = httpRequest(
			new URL(req.url ?? "/", upstream),
			{ method: req.method, headers: req.headers },
			(response) => {
				res.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(res);
			},
		);
		outgoing.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end();
		});
		res.on("close", () => outgoing.destroy());
		req.pipe(outgoing);
	},
);
await new Promise<void>((resolve, reject) => {
	proxy.once("error", reject);
	proxy.listen(34443, "127.0.0.1", resolve);
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({ ignoreHTTPSErrors: true });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(origin, { waitUntil: "domcontentloaded" });
	await expect(page).toHaveTitle("Glasshouse by SquashMerge");
	await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
	const provisioned = await page.evaluate(async () => {
		const anonymous = await fetch("/v1/projects");
		const created = await fetch("/v1/admin/local-accounts", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				Authorization: `Basic ${btoa("synthetic-owner:synthetic-ui-9b412e8cfa")}`,
			},
			body: JSON.stringify({ username: "candidate.reader", role: "read_only" }),
		});
		if (created.status !== 200)
			throw new Error(`Provision failed: ${created.status}`);
		const account = await created.json();
		const enrolled = await fetch("/v1/auth/invitations/accept", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: account.code,
				password: "synthetic-browser-93b1e75a",
			}),
		});
		return { anonymous: anonymous.status, enrolled: enrolled.status };
	});
	expect(provisioned).toEqual({ anonymous: 401, enrolled: 200 });
	await page.getByLabel("Username", { exact: true }).fill("candidate.reader");
	await page
		.getByLabel("Password", { exact: true })
		.fill("synthetic-browser-93b1e75a");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Organization overview" }),
	).toBeVisible();
	const cookies = await context.cookies();
	expect(
		cookies.some(
			(cookie) =>
				cookie.name === "glasshouse_session" &&
				cookie.httpOnly &&
				cookie.secure,
		),
	).toBe(true);
	const result = await page.evaluate(async (foreign) => {
		const session = await fetch("/v1/auth/session");
		const sessionBody = await session.json();
		const projects = await fetch("/v1/projects");
		const items = (await projects.json()).items;
		const local = items.find(
			(item: { slug: string }) => item.slug === "default",
		);
		if (!local) throw new Error("Default project unavailable");
		const localTrace = await fetch(`/v1/traces?project_id=${local.id}`);
		const foreignRead = await fetch(`/v1/projects/${foreign}`);
		const foreignTrace = await fetch(`/v1/traces?project_id=${foreign}`);
		const foreignSse = await fetch(`/v1/traces/events?project_id=${foreign}`);
		const foreignWrite = await fetch(`/v1/projects/${foreign}`, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				"x-glasshouse-csrf": sessionBody.csrf_token,
			},
			body: JSON.stringify({ name: "Cross-tenant mutation" }),
		});
		const noCsrf = await fetch("/v1/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Denied", slug: "denied" }),
		});
		const localStream = await fetch(
			`/v1/traces/events?project_id=${local.id}`,
			{ signal: AbortSignal.timeout(10000) },
		);
		const reader = localStream.body!.getReader();
		let streamText = "";
		while (!streamText.includes(":ok")) {
			const part = await reader.read();
			if (part.done || streamText.length > 4096) break;
			streamText += new TextDecoder().decode(part.value);
		}
		await reader.cancel();
		return {
			session: session.status,
			kind: sessionBody.authentication,
			projects: projects.status,
			localTrace: localTrace.status,
			foreignListed: items.some((item: { id: string }) => item.id === foreign),
			foreignRead: foreignRead.status,
			foreignTrace: foreignTrace.status,
			foreignSse: foreignSse.status,
			foreignWrite: foreignWrite.status,
			noCsrf: noCsrf.status,
			stream: localStream.status,
			streamText,
		};
	}, foreignProject);
	expect(result.session).toBe(200);
	expect(result.kind).toBe("local_session");
	expect(result.projects).toBe(200);
	expect(result.localTrace).toBe(200);
	expect(result.foreignListed).toBe(false);
	for (const status of [
		result.foreignRead,
		result.foreignTrace,
		result.foreignSse,
		result.foreignWrite,
	])
		expect([403, 404]).toContain(status);
	expect(result.noCsrf).toBe(403);
	expect(result.stream).toBe(200);
	expect(result.streamText).toContain(":ok");
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(
		page.getByRole("heading", { name: "Organization overview" }),
	).toBeVisible();
	expect(errors).toEqual([]);
	await context.close();
} finally {
	await browser?.close();
	await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
