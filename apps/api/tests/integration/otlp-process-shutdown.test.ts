import { expect, test } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import { createConnection, createServer } from "node:net";

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
		env.POSTGRES_PORT === "5432" &&
		env.CLICKHOUSE_HOST === "clickhouse" &&
		(env.CLICKHOUSE_HTTP_PORT ?? "8123") === "8123" &&
		env.VALKEY_HOST === "valkey" &&
		(env.VALKEY_PORT ?? "6379") === "6379" &&
		env.DATABASE_URL === undefined &&
		env.CLICKHOUSE_URL === undefined &&
		env.VALKEY_URL === undefined &&
		env.VALKEY_PUBSUB_URL === undefined
	);
}

function sanitizedChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const child = Object.fromEntries(
		Object.entries(env).filter(([key]) => !key.startsWith("PG")),
	);
	const database = new URL("postgresql://postgres:5432");
	database.username = env.POSTGRES_USER ?? "postgres";
	database.password = env.POSTGRES_PASSWORD ?? "postgres";
	database.pathname = `/${encodeURIComponent(env.POSTGRES_DB ?? "postgres")}`;
	child.DATABASE_URL = database.toString();
	const valkey = new URL("redis://valkey:6379");
	valkey.password = env.VALKEY_PASSWORD ?? "";
	child.VALKEY_URL = valkey.toString();
	return child;
}

test("shutdown test refuses inherited or non-disposable datastore configuration", () => {
	const safe = {
		OTLP_SHUTDOWN_DISPOSABLE: "1",
		GLASSHOUSE_CONTAINER_NETWORK: "1",
		POSTGRES_HOST: "postgres",
		POSTGRES_PORT: "5432",
		CLICKHOUSE_HOST: "clickhouse",
		VALKEY_HOST: "valkey",
	};
	expect(disposableEnvironment(safe)).toBe(true);
	for (const unsafe of [
		{ ...safe, OTLP_SHUTDOWN_DISPOSABLE: undefined },
		{ ...safe, GLASSHOUSE_CONTAINER_NETWORK: undefined },
		{ ...safe, NODE_ENV: "production" },
		{ ...safe, POSTGRES_HOST: "localhost" },
		{ ...safe, POSTGRES_PORT: "6543" },
		{ ...safe, CLICKHOUSE_HOST: "localhost" },
		{ ...safe, VALKEY_HOST: "localhost" },
		{ ...safe, CLICKHOUSE_HTTP_PORT: "8123@unsafe-example.invalid:8123" },
		{ ...safe, VALKEY_PORT: "6379@unsafe-example.invalid:6379" },
		{ ...safe, VALKEY_PUBSUB_URL: "redis://unsafe-example.invalid:6379" },
		{ ...safe, DATABASE_URL: "postgres://example" },
		{ ...safe, DATABASE_URL: "" },
		{ ...safe, CLICKHOUSE_URL: "" },
		{ ...safe, VALKEY_URL: "" },
		{ ...safe, CLICKHOUSE_URL: "http://example" },
		{ ...safe, VALKEY_URL: "redis://example" },
	])
		expect(disposableEnvironment(unsafe)).toBe(false);
});

test("shutdown child resolves its PostgreSQL target without inherited PG settings", () => {
	const env = sanitizedChildEnvironment({
		...process.env,
		PGHOST: "unsafe-example.invalid",
		PGPORT: "6543",
		DATABASE_URL: undefined,
		POSTGRES_HOST: "postgres",
		POSTGRES_PORT: "5432",
		POSTGRES_DB: "glasshouse?host=unsafe-example.invalid",
	});
	const result = Bun.spawnSync(
		[
			process.execPath,
			"--no-env-file",
			"-e",
			'import { Client } from "pg"; import { postgresUrl } from "./src/db/postgres.ts"; console.log(new Client({connectionString: postgresUrl()}).connectionParameters.host);',
		],
		{ cwd: import.meta.dir + "/../..", env },
	);
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString().trim()).toBe("postgres");
});

test("shutdown child pins Valkey despite a URL-like password", () => {
	const env = sanitizedChildEnvironment({
		VALKEY_PASSWORD: "x@unsafe-example.invalid:6379/#",
		VALKEY_HOST: "valkey",
		VALKEY_PORT: "6379",
	});
	const result = Bun.spawnSync(
		[
			process.execPath,
			"--no-env-file",
			"-e",
			'import Redis from "ioredis"; import { valkeyUrl } from "./src/db/valkey.ts"; const client = new Redis(valkeyUrl(), { lazyConnect: true }); console.log(client.options.host); client.disconnect();',
		],
		{ cwd: import.meta.dir + "/../..", env },
	);
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString().trim()).toBe("valkey");
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	test.skipIf(!disposableEnvironment(process.env))(
		`API shuts down HTTP and gRPC on ${signal}`,
		async () => {
			const httpPort = await unusedPort();
			const grpcPort = await unusedPort();
			const child = Bun.spawn(
				[process.execPath, "--no-env-file", "run", "src/index.ts"],
				{
					cwd: import.meta.dir + "/../..",
					env: {
						...sanitizedChildEnvironment(process.env),
						API_PORT: String(httpPort),
						OTLP_GRPC_PORT: String(grpcPort),
						OTLP_GRPC_HOST: "127.0.0.1",
					},
					stdout: "ignore",
					stderr: "ignore",
				},
			);
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
				const grpcClosed = await new Promise<boolean>((resolve) => {
					const socket = createConnection({
						host: "127.0.0.1",
						port: grpcPort,
					});
					socket.once("connect", () => {
						socket.destroy();
						resolve(false);
					});
					socket.once("error", () => resolve(true));
					socket.setTimeout(1000, () => {
						socket.destroy();
						resolve(false);
					});
				});
				expect(grpcClosed).toBe(true);
			} finally {
				grpcClient.close();
				if (child.exitCode === null) child.kill("SIGKILL");
				await child.exited;
			}
		},
		30_000,
	);
}
