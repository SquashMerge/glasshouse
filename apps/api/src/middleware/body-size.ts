// Request body size limit middleware. Rejects requests with bodies larger
// than `maxBytes` (default 1 MiB) with 413 Payload Too Large.
//
// The OTLP spec recommends exporters chunk large trace batches; a 1 MiB body
// limit is plenty for a typical export (a few hundred spans).
// Production deployments can raise this via env: `API_MAX_BODY_BYTES`.

import type { MiddlewareHandler } from "hono";

export function bodySizeLimit(maxBytes: number = 1_048_576): MiddlewareHandler {
  return async (c, next) => {
    const contentLength = c.req.header("content-length");
    if (contentLength) {
      const len = Number(contentLength);
      if (Number.isFinite(len) && len > maxBytes) {
        return c.json(
          { code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds ${maxBytes} bytes` },
          413,
        );
      }
    }
    // Belt-and-suspenders: enforce at the stream level for chunked transfer
    // encoding (where Content-Length is absent).
    let total = 0;
    const reader = c.req.raw.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            try { await reader.cancel(); } catch { /* noop */ }
            return c.json(
              { code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds ${maxBytes} bytes` },
              413,
            );
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* noop */ }
      }
    }
    await next();
  };
}