import { join } from "node:path";
import { serveStatic } from "hono/bun";
import type { MiddlewareHandler } from "hono";

const WEB_CSP =
	"default-src 'self'; base-uri 'self'; connect-src 'self' ws: wss:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; style-src 'self' 'unsafe-inline'";

export function releaseWeb(directory: string): MiddlewareHandler {
	const staticFiles = serveStatic({ root: directory });
	return async (c, next) => {
		const path = c.req.path;
		if (
			(c.req.method !== "GET" && c.req.method !== "HEAD") ||
			path === "/v1" ||
			path.startsWith("/v1/") ||
			["/health", "/reference", "/openapi.json"].includes(path)
		)
			return next();
		c.header("Content-Security-Policy", WEB_CSP);
		c.header("X-Content-Type-Options", "nosniff");
		c.header("X-Frame-Options", "DENY");
		c.header("Referrer-Policy", "no-referrer");
		c.header("Cross-Origin-Opener-Policy", "same-origin");
		c.header("Cross-Origin-Resource-Policy", "same-origin");
		if (path.includes("%") || path.includes("\\")) return c.notFound();
		const response = await staticFiles(c, async () => {});
		if (response) return response;
		if (path.startsWith("/assets/") || /\.[^/]+$/.test(path))
			return c.notFound();
		const index = Bun.file(join(directory, "index.html"));
		if (!(await index.exists())) return c.notFound();
		c.header("Content-Type", "text/html; charset=utf-8");
		return c.body(index);
	};
}
