// TODO(post-MVP): add Strict-Transport-Security, Content-Security-Policy,
// Cross-Origin-Opener-Policy, Cross-Origin-Resource-Policy at the edge proxy.

import type { MiddlewareHandler } from "hono";

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
	};
}
