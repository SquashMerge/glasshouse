import { expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { createClient } from "@clickhouse/client";
import { Client } from "pg";
import {
	applyClickHouseMigrations,
	withClickHouseMigrationLock,
} from "../../src/db/clickhouse-migrate.js";
import { logger } from "../../src/lib/logger.js";
import { otlpDisposableDatastores } from "../helpers/otlp-disposable-datastores.js";

const directory = new URL("../../../../infra/db/clickhouse/", import.meta.url);
const migration = "0012_logs_physical_uuid.sql";
const timeoutMs = 100;

async function stalledMigration(
	target: "mutation-poll" | "ledger",
	stage: "headers" | "body" | "trickle",
) {
	const applied = new Map(
		readdirSync(directory)
			.filter((file) => /^\d+_.+\.sql$/.test(file) && file < "0012_")
			.map((file) => [
				file,
				createHash("sha256")
					.update(readFileSync(new URL(file, directory)))
					.digest("hex"),
			]),
	);
	const sockets = new Set<Socket>();
	const queries: string[] = [];
	let stalledSocket: Socket | undefined;
	let peerClosed = false;
	let trickle: ReturnType<typeof setInterval> | undefined;
	let reached!: () => void;
	const stalled = new Promise<void>((resolve) => {
		reached = resolve;
	});
	// Read FIN directly: an HTTP server's paused parser can hide peer closure.
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => {
			sockets.delete(socket);
			if (socket === stalledSocket) {
				peerClosed = true;
				clearInterval(trickle);
			}
		});
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			const headerEnd = buffered.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			const headers = buffered.subarray(0, headerEnd).toString();
			const length = Number(/content-length: (\d+)/i.exec(headers)![1]);
			if (buffered.length < headerEnd + 4 + length) return;
			const url = new URL(headers.split(" ")[1]!, "http://127.0.0.1");
			const query = buffered
				.subarray(headerEnd + 4, headerEnd + 4 + length)
				.toString();
			buffered = buffered.subarray(headerEnd + 4 + length);
			queries.push(query);
			const poll = query.includes("system.mutations");
			const ledger = query.startsWith(
				"INSERT INTO glasshouse_schema_migrations",
			);
			if (ledger) {
				// Acceptance precedes the acknowledgement; cancellation cannot undo it.
				applied.set(
					url.searchParams.get("param_migration")!,
					url.searchParams.get("param_checksum")!,
				);
			}
			if (
				(target === "mutation-poll" && poll) ||
				(target === "ledger" && ledger)
			) {
				stalledSocket = socket;
				if (stage !== "headers") {
					socket.write(
						"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n \r\n",
					);
					if (stage === "trickle")
						trickle = setInterval(() => socket.write("1\r\n \r\n"), 20);
				}
				reached();
				return;
			}
			const body = query.startsWith("SELECT migration, checksum")
				? [...applied]
						.map(([migration, checksum]) =>
							JSON.stringify({ migration, checksum }),
						)
						.join("\n") + "\n"
				: poll
					? '{"pending":"0","failed":"0"}\n'
					: query.includes("AS needs_backfill")
						? '{"needs_backfill":0}\n'
						: "";
			socket.write(
				`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const client = createClient({
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		request_timeout: 5_000,
		max_open_connections: 1,
		log: { level: "OFF" },
	});
	return {
		client,
		applied,
		queries,
		stalled,
		peerClosed: () => peerClosed,
		lateAcknowledgement: () => {
			if (stalledSocket && !stalledSocket.destroyed) {
				clearInterval(trickle);
				if (stage === "headers")
					stalledSocket.write(
						"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
					);
				const body =
					target === "mutation-poll" ? '{"pending":"0","failed":"0"}\n' : "";
				stalledSocket.write(
					(body
						? `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n`
						: "") + "0\r\n\r\n",
				);
			}
		},
		close: async () => {
			clearInterval(trickle);
			for (const socket of sockets) socket.destroy();
			await client.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function migrationLock(realPostgres: boolean) {
	let held = false;
	let ended = false;
	let admin: Client | undefined;
	let observer: Client | undefined;
	let session: Client | undefined;
	let created = false;
	const database = `otlp_extension_${randomUUID().replaceAll("-", "")}`;
	const close = async () => {
		await observer?.end();
		await session?.end();
		try {
			if (created) await admin!.query(`DROP DATABASE ${database}`);
		} finally {
			await admin?.end();
		}
	};
	try {
		if (realPostgres) {
			const config = otlpDisposableDatastores(process.env, database);
			admin = new Client({ connectionString: config.postgresAdminUrl });
			await admin.connect();
			await admin.query(`CREATE DATABASE ${database}`);
			created = true;
			session = new Client({ connectionString: config.postgresUrl });
			observer = new Client({ connectionString: config.postgresUrl });
			await observer.connect();
			expect(
				(await observer.query("SELECT current_database() AS name")).rows,
			).toEqual([{ name: database }]);
		}
		const lockClient = {
			connect: async () => {
				await session?.connect();
			},
			query:
				session?.query.bind(session) ??
				(async (query: string) => {
					if (query.includes("pg_advisory_lock(")) held = true;
					if (query.includes("pg_advisory_unlock(")) held = false;
					return {} as never;
				}),
			end: async () => {
				await session?.end();
				ended = true;
			},
		};
		return {
			withLock: <T>(run: () => Promise<T>) =>
				withClickHouseMigrationLock(run, () => lockClient),
			state: async () => {
				if (observer) {
					const params = ["glasshouse.clickhouse-schema-migrations"];
					const result = await observer.query(
						"SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
						params,
					);
					held = !result.rows[0].acquired;
					if (!held)
						await observer.query(
							"SELECT pg_advisory_unlock(hashtext($1))",
							params,
						);
				}
				return { held, ended };
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}

const lockModes =
	process.env.GLASSHOUSE_CONTAINER_NETWORK === "1" ? [false, true] : [false];
for (const realPostgres of lockModes) {
	for (const target of ["mutation-poll", "ledger"] as const) {
		for (const stage of realPostgres
			? (["body"] as const)
			: (["headers", "body", "trickle"] as const)) {
			test(`0012 deadline closes stalled ${target} ${stage} and releases its ${realPostgres ? "owned PostgreSQL" : "injected"} migration lock`, async () => {
				const lock = await migrationLock(realPostgres);
				const fixture = await stalledMigration(target, stage);
				let settlement = "pending";
				let settledAfterMs = 0;
				const started = Date.now();
				const reports: string[] = [];
				const reporting = spyOn(logger, "info").mockImplementation(
					(event, fields) => {
						if (event === "clickhouse.migration.applied")
							reports.push(String(fields?.migration));
					},
				);
				const work = applyClickHouseMigrations(fixture.client, lock.withLock, {
					logsWriterMaintenance: true,
					logsUuidTimeoutMs: timeoutMs,
				}).then(
					() => {
						settlement = "resolved";
						return undefined;
					},
					(error: unknown) => {
						settlement = "rejected";
						settledAfterMs = Date.now() - started;
						return error;
					},
				);
				try {
					await fixture.stalled;
					expect(await lock.state()).toEqual({ held: true, ended: false });
					await Bun.sleep(timeoutMs + 250);
					const atDeadline = {
						settlement,
						...(await lock.state()),
						peerClosed: fixture.peerClosed(),
					};
					fixture.lateAcknowledgement();
					const failure = await work;
					expect({
						atDeadline,
						afterLateAcknowledgement: { settlement, reports },
					}).toEqual({
						atDeadline: {
							settlement: "rejected",
							held: false,
							ended: true,
							peerClosed: true,
						},
						afterLateAcknowledgement: { settlement: "rejected", reports: [] },
					});
					expect(failure).toBeInstanceOf(Error);
					expect(settledAfterMs).toBeLessThan(timeoutMs + 250);
					expect((failure as Error).message).toContain(
						"0012 deadline exceeded",
					);
					expect(reports).not.toContain(migration);
					expect(fixture.applied.has(migration)).toBe(target === "ledger");
					expect(
						fixture.queries.some((query) => query.startsWith("KILL")),
					).toBe(false);
				} finally {
					await fixture.close();
					await work;
					reporting.mockRestore();
					await lock.close();
				}
			}, 10_000);
		}
	}
}
