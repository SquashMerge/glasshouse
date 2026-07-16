import type { MiddlewareHandler } from "hono";

export function bodySizeLimit(maxBytes: number = 1_048_576): MiddlewareHandler {
	return async (c, next) => {
		const contentLength = c.req.header("content-length");
		if (contentLength) {
			const len = Number(contentLength);
			if (Number.isFinite(len) && len > maxBytes) {
				return c.json(
					{
						code: "PAYLOAD_TOO_LARGE",
						message: `Request body exceeds ${maxBytes} bytes`,
					},
					413,
				);
			}
		}

		const incoming = c.req.raw.body;
		if (!incoming) {
			await next();
			return;
		}

		// Buffer the body so we can enforce a size cap AND let the handler read it.
		// Without this, chunked bodies (no Content-Length) get consumed here and the
		// handler then fails with "Body already used".
		const reader = incoming.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > maxBytes) {
					try {
						await reader.cancel();
					} catch {
						/* noop */
					}
					return c.json(
						{
							code: "PAYLOAD_TOO_LARGE",
							message: `Request body exceeds ${maxBytes} bytes`,
						},
						413,
					);
				}
				chunks.push(value);
			}
		} finally {
			try {
				reader.releaseLock();
			} catch {
				/* noop */
			}
		}

		const buf = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			buf.set(chunk, offset);
			offset += chunk.byteLength;
		}
		c.req.raw = new Request(c.req.raw, { body: buf });

		await next();
	};
}
