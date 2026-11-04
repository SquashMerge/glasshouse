import { expect, test as bunTest } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Starting the API runs recovery against the configured database.
const test =
	process.env.GLASSHOUSE_TEST_DISPOSABLE_RECOVERY_DB === "1"
		? bunTest
		: bunTest.skip;

async function unusedPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string")
				return reject(new Error("No port"));
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	test(`API shuts down HTTP and gRPC on ${signal}`, async () => {
		const httpPort = await unusedPort();
		const grpcPort = await unusedPort();
		const webRoot = await mkdtemp(
			join(process.cwd(), "node_modules", ".otlp-web-"),
		);
		await writeFile(
			join(webRoot, "index.html"),
			"<html>Integration shell</html>",
		);
		const child = Bun.spawn([process.execPath, "run", "src/index.ts"], {
			cwd: import.meta.dir + "/../..",
			env: {
				...process.env,
				API_PORT: String(httpPort),
				OTLP_GRPC_PORT: String(grpcPort),
				OTLP_GRPC_HOST: "127.0.0.1",
				GLASSHOUSE_WEB_ROOT: webRoot,
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		const grpcClient = new grpc.Client(
			`127.0.0.1:${grpcPort}`,
			grpc.credentials.createInsecure(),
		);
		try {
			await new Promise<void>((resolve, reject) =>
				grpcClient.waitForReady(Date.now() + 15_000, (error) =>
					error ? reject(error) : resolve(),
				),
			);
			const response = await fetch(`http://127.0.0.1:${httpPort}/health`);
			expect(response.status).toBeGreaterThan(0);
			const shell = await fetch(`http://127.0.0.1:${httpPort}/login`, {
				headers: { accept: "text/html" },
			});
			expect(shell.status).toBe(200);
			expect(await shell.text()).toContain("Integration shell");
			const ingest = await fetch(`http://127.0.0.1:${httpPort}/v1/traces`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(ingest.status).toBe(401);
			grpcClient.close();
			child.kill(signal);
			const result = await Promise.race([
				child.exited,
				Bun.sleep(12_000).then(() => "timeout" as const),
			]);
			expect(result).not.toBe("timeout");
			expect(result).toBe(0);
			await expect(
				fetch(`http://127.0.0.1:${httpPort}/health`),
			).rejects.toThrow();
			const closedClient = new grpc.Client(
				`127.0.0.1:${grpcPort}`,
				grpc.credentials.createInsecure(),
			);
			try {
				await expect(
					new Promise<void>((resolve, reject) =>
						closedClient.waitForReady(Date.now() + 1_000, (error) =>
							error ? reject(error) : resolve(),
						),
					),
				).rejects.toThrow();
			} finally {
				closedClient.close();
			}
		} finally {
			grpcClient.close();
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
			await rm(webRoot, { recursive: true, force: true });
		}
	}, 30_000);
}
