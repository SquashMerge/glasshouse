import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { valkey } from "../../src/db/valkey";
import {
	_resetForTests,
	ensureConnected,
	publishOnChannel,
	subscribeToChannel,
} from "../../src/db/valkey-pubsub";

// Changes requirepass briefly: opt in only against an isolated disposable server.
const disposableTest =
	process.env.GLASSHOUSE_DISPOSABLE_VALKEY_TEST === "1" ? test : test.skip;
disposableTest(
	"real Valkey authenticates component passwords and pubsub URL overrides",
	async () => {
		const keys = [
			"VALKEY_URL",
			"VALKEY_PUBSUB_URL",
			"VALKEY_HOST",
			"VALKEY_PORT",
			"VALKEY_PASSWORD",
		] as const;
		const original = Object.fromEntries(
			keys.map((key) => [key, process.env[key]]),
		);
		const host = process.env.VALKEY_HOST ?? "localhost";
		const port = Number(process.env.VALKEY_PORT ?? "6379");
		const oldPassword = process.env.VALKEY_PASSWORD;
		if (!oldPassword) throw new Error("Isolated Valkey password is required");
		const admin = new Redis({
			host,
			port,
			password: oldPassword,
			lazyConnect: true,
		});
		const password = "synthetic-#?/%@:$+ secret";
		let changed = false;
		try {
			await admin.connect();
			await admin.config("SET", "requirepass", password);
			changed = true;
			delete process.env.VALKEY_URL;
			delete process.env.VALKEY_PUBSUB_URL;
			process.env.VALKEY_PASSWORD = password;
			await valkey().connect();
			expect(await valkey().ping()).toBe("PONG");

			// A conflicting component password and read URL must not override pub/sub credentials.
			process.env.VALKEY_PASSWORD = "wrong-component-secret";
			process.env.VALKEY_URL =
				"redis://:wrong-read-secret@invalid-read-host:6379";
			process.env.VALKEY_PUBSUB_URL = `redis://:${encodeURIComponent(password)}@${host}:${port}`;
			await ensureConnected();
			const channel = `glasshouse:valkey-password-test:${randomUUID()}`;
			try {
				const received = new Promise<string>((resolve) => {
					subscribeToChannel(channel, resolve);
				});
				const interval = setInterval(
					() => void publishOnChannel(channel, "delivered"),
					50,
				);
				try {
					expect(
						await Promise.race([
							received,
							new Promise((_, reject) =>
								setTimeout(() => reject(new Error("pubsub timed out")), 3000),
							),
						]),
					).toBe("delivered");
				} finally {
					clearInterval(interval);
				}
			} finally {
				_resetForTests();
			}
		} finally {
			valkey().disconnect();
			if (changed) await admin.config("SET", "requirepass", oldPassword);
			admin.disconnect();
			for (const key of keys) {
				if (original[key] === undefined) delete process.env[key];
				else process.env[key] = original[key];
			}
		}
	},
	10000,
);
