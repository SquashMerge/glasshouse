// Security headers middleware.
// Applied to ALL routes (public + auth-gated). Sets:
//   - X-Content-Type-Options: nosniff       (block MIME sniffing)
//   - X-Frame-Options: DENY                  (block clickjacking iframes)
//   - Referrer-Policy: no-referrer           (don't leak the API URL to upstream services)
//   - Permissions-Policy: ...                (lock down powerful browser features)
//   - X-DNS-Prefetch-Control: off            (don't prefetch DNS for links in responses)
//
// For production (post-MVP), also add via the edge proxy:
//   - Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
//   - Content-Security-Policy: default-src 'self'
//   - Cross-Origin-Opener-Policy: same-origin
//   - Cross-Origin-Resource-Policy: same-site

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