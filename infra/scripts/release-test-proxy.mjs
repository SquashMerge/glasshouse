// Disposable HTTPS edge used only by the release-image integration test.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";

const [keyPath, certPath] = process.argv.slice(2);
if (!keyPath || !certPath) throw new Error("key and certificate required");
createServer(
	{ key: readFileSync(keyPath), cert: readFileSync(certPath) },
	(incoming, response) => {
		const upstream = request(
			{
				hostname: "127.0.0.1",
				port: 34762,
				path: incoming.url,
				method: incoming.method,
				headers: incoming.headers,
			},
			(result) => {
				response.writeHead(result.statusCode ?? 502, result.headers);
				result.pipe(response);
			},
		);
		upstream.on("error", () => {
			if (!response.headersSent) response.writeHead(502);
			response.end();
		});
		incoming.pipe(upstream);
	},
).listen(34763, "127.0.0.1");
