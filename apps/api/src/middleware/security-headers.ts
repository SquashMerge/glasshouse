import type { MiddlewareHandler } from "hono";

const API_CONTENT_SECURITY_POLICY =
	"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Scalar's reference page may load configurable external assets.
const REFERENCE_CONTENT_SECURITY_POLICY =
	"base-uri 'self'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

const PERMISSIONS_POLICY = [
	"accelerometer=()",
	"ambient-light-sensor=()",
	"autoplay=()",
	"battery=()",
	"camera=()",
	"display-capture=()",
	"document-domain=()",
	"encrypted-media=()",
	"fullscreen=(self)",
	"geolocation=()",
	"gyroscope=()",
	"layout-animations=(self)",
	"legacy-image-formats=(self)",
	"magnetometer=()",
	"microphone=()",
	"midi=()",
	"oversized-images=(self)",
	"payment=()",
	"picture-in-picture=()",
	"publickey-credentials-get=(self)",
	"screen-wake-lock=()",
	"sync-xhr=(self)",
	"unoptimized-images=(self)",
	"unsized-media=(self)",
	"usb=()",
	"web-share=()",
	"xr-spatial-tracking=()",
].join(", ");

export function securityHeaders(): MiddlewareHandler {
	return async (c, next) => {
		await next();
		c.header("X-Content-Type-Options", "nosniff");
		c.header("X-Frame-Options", "DENY");
		c.header("Referrer-Policy", "no-referrer");
		c.header("Permissions-Policy", PERMISSIONS_POLICY);
		c.header("X-DNS-Prefetch-Control", "off");
		c.header(
			"Content-Security-Policy",
			c.req.path === "/reference"
				? REFERENCE_CONTENT_SECURITY_POLICY
				: API_CONTENT_SECURITY_POLICY,
		);
		c.header("Cross-Origin-Opener-Policy", "same-origin");
		c.header("Cross-Origin-Resource-Policy", "same-origin");
	};
}
