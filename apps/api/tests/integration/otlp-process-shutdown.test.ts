import { expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { createServer } from "node:net";

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

function disposableEnvironment(env: NodeJS.ProcessEnv): boolean {
	return (
		env.OTLP_SHUTDOWN_DISPOSABLE === "1" &&
		env.GLASSHOUSE_CONTAINER_NETWORK === "1" &&
		env.NODE_ENV !== "production" &&
		env.POSTGRES_HOST === "postgres" &&
		env.CLICKHOUSE_HOST === "clickhouse" &&
		env.VALKEY_HOST === "valkey" &&
		!env.DATABASE_URL &&
		!env.CLICKHOUSE_URL &&
		!env.VALKEY_URL
	);
}

test("shutdown test refuses inherited or non-disposable datastore configuration", () => {
	const safe = {
		OTLP_SHUTDOWN_DISPOSABLE: "1",
		GLASSHOUSE_CONTAINER_NETWORK: "1",
		POSTGRES_HOST: "postgres",
		CLICKHOUSE_HOST: "clickhouse",
		VALKEY_HOST: "valkey",
	};
	expect(disposableEnvironment(safe)).toBe(true);
	for (const unsafe of [
		{ ...safe, OTLP_SHUTDOWN_DISPOSABLE: undefined },
		{ ...safe, GLASSHOUSE_CONTAINER_NETWORK: undefined },
		{ ...safe, NODE_ENV: "production" },
		{ ...safe, POSTGRES_HOST: "localhost" },
		{ ...safe, CLICKHOUSE_HOST: "localhost" },
		{ ...safe, VALKEY_HOST: "localhost" },
		{ ...safe, DATABASE_URL: "postgres://example" },
		{ ...safe, CLICKHOUSE_URL: "http://example" },
		{ ...safe, VALKEY_URL: "redis://example" },
	])
		expect(disposableEnvironment(unsafe)).toBe(false);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	test.skipIf(!disposableEnvironment(process.env))(
		`API shuts down HTTP and gRPC on ${signal}`,
		async () => {
			const httpPort = await unusedPort();
			const grpcPort = await unusedPort();
			const child = Bun.spawn([process.execPath, "run", "src/index.ts"], {
				cwd: import.meta.dir + "/../..",
				env: {
					...process.env,
					API_PORT: String(httpPort),
					OTLP_GRPC_PORT: String(grpcPort),
					OTLP_GRPC_HOST: "127.0.0.1",
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
			} finally {
				grpcClient.close();
				if (child.exitCode === null) child.kill("SIGKILL");
				await child.exited;
			}
		},
		30_000,
	);
}
