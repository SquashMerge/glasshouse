import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const WEB_CSP = [
	"default-src 'self'",
	"base-uri 'self'",
	"connect-src 'self' ws: wss:",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"img-src 'self' data:",
	"object-src 'none'",
	"style-src 'self' 'unsafe-inline'",
].join("; ");

const webHeaders = {
	"Cache-Control": "no-cache",
	"Content-Security-Policy": WEB_CSP,
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
};

type ApiFetch = (request: Request) => Response | Promise<Response>;

export function createSingleImageFetch(root: string, apiFetch: ApiFetch) {
	const webRoot = resolve(root);
	return async (request: Request): Promise<Response> => {
		const rawPath = new URL(request.url).pathname;
		let path: string;
		try {
			path = decodeURIComponent(rawPath);
		} catch {
			return new Response("Not Found", { status: 404, headers: webHeaders });
		}
		// Keep every API request, including unknown routes and non-GET methods,
		// behind exactly the existing middleware chain.
		if (
			(request.method !== "GET" && request.method !== "HEAD") ||
			path === "/v1" ||
			path.startsWith("/v1/") ||
			["/health", "/openapi.json", "/reference"].includes(path)
		)
			return apiFetch(request);

		const notFound = () =>
			new Response("Not Found", { status: 404, headers: webHeaders });
		if (
			path.includes("\\") ||
			path.includes("%") ||
			path.includes("\0") ||
			path.split("/").some((part) => part.startsWith("."))
		)
			return notFound();

		const serve = async (name: string): Promise<Response | undefined> => {
			try {
				const file = await realpath(resolve(webRoot, `.${name}`));
				const actualRoot = await realpath(webRoot);
				if (
					!file.startsWith(`${actualRoot}${sep}`) ||
					!(await stat(file)).isFile()
				)
					return;
				const body = Bun.file(file);
				return new Response(request.method === "HEAD" ? null : body, {
					headers: {
						...webHeaders,
						"Content-Type": body.type || "application/octet-stream",
					},
				});
			} catch {
				return;
			}
		};
		const asset = await serve(path);
		if (asset) return asset;
		if (
			path === "/assets" ||
			path.startsWith("/assets/") ||
			extname(path) ||
			(path !== "/" &&
				!request.headers.get("accept")?.toLowerCase().includes("text/html"))
		)
			return notFound();
		return (await serve("/index.html")) ?? notFound();
	};
}
