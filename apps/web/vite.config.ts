import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_API_PROXY ?? "http://localhost:3000";

const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' ws: wss:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "style-src 'self' 'unsafe-inline'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// @vitejs/plugin-react injects an inline preamble into the development HTML.
// Keep this exception on the dev server only; preview serves the built bundle.
const developmentSecurityHeaders = {
  ...securityHeaders,
  "Content-Security-Policy": [
    securityHeaders["Content-Security-Policy"],
    "script-src 'self' 'unsafe-inline'",
  ].join("; "),
};

/**
 * `configureProxyForSSE` patches http-proxy's response side so that
 * `text/event-stream` responses are NOT buffered — chunks flush as the
 * upstream writes them. Without this, the default Node socket buffering
 * makes the browser only see SSE events when the upstream closes the
 * response (or after a sizable buffer fills), delaying live updates on
 * the list pages until the stream is flushed.
 *
 * Also writes `cache-control: no-cache` and the nginx-convention
 * `x-accel-buffering: no` so the same proxy config works behind a
 * production nginx reverse proxy without further changes.
 */
type ProxyResponse = {
  headers: Record<string, string | string[] | undefined>;
  socket: {
    setNoDelay?: (n: boolean) => void;
    setTimeout?: (n: number) => void;
  } | null;
};

type HttpProxyLike = {
  on: (event: "proxyRes", listener: (proxyRes: ProxyResponse) => void) => void;
};

function configureProxyForSSE(proxy: HttpProxyLike): void {
  proxy.on("proxyRes", (proxyRes) => {
    const contentType = proxyRes.headers["content-type"] ?? "";
    if (typeof contentType === "string" && contentType.includes("text/event-stream")) {
      proxyRes.headers["cache-control"] = "no-cache";
      proxyRes.headers["x-accel-buffering"] = "no";
      const socket = proxyRes.socket as
        | { setNoDelay?: (n: boolean) => void; setTimeout?: (n: number) => void }
        | null;
      socket?.setNoDelay?.(true);
      socket?.setTimeout?.(0);
    }
  });
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    headers: developmentSecurityHeaders,
    proxy: {
      "/v1": {
        target: apiTarget,
        changeOrigin: true,
        configure: configureProxyForSSE,
      },
      "/openapi.json": { target: apiTarget, changeOrigin: true },
      "/reference": { target: apiTarget, changeOrigin: true },
      "/health": { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    headers: securityHeaders,
  },
});
