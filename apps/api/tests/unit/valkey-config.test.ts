import { afterEach, expect, test } from "bun:test";
import Redis from "ioredis";
import { valkeyConnection } from "../../src/db/valkey";

const keys = [
	"VALKEY_URL",
	"VALKEY_HOST",
	"VALKEY_PORT",
	"VALKEY_PASSWORD",
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
afterEach(() => {
	for (const key of keys) {
		if (original[key] === undefined) delete process.env[key];
		else process.env[key] = original[key];
	}
});

function clientFor(url?: string): Redis {
	const connection = valkeyConnection(url);
	return new Redis(connection.url, {
		...(connection.password !== undefined
			? { password: connection.password }
			: {}),
		lazyConnect: true,
	});
}

test("component credentials are passed verbatim without URL interpolation", () => {
	delete process.env.VALKEY_URL;
	process.env.VALKEY_HOST = "valkey";
	process.env.VALKEY_PORT = "6380";
	for (const password of ["a#b", "a?b", "a/b", "a%b", "a@b:c+$ unicode ü"]) {
		process.env.VALKEY_PASSWORD = password;
		const config = valkeyConnection();
		expect(config.url).toBe("redis://valkey:6380");
		const client = clientFor();
		expect(client.options.password).toBe(password);
		expect(client.options.port).toBe(6380);
		client.disconnect();
	}
});

test("explicit URL credentials are trusted instead of component credentials", () => {
	process.env.VALKEY_PASSWORD = "different-component-password";
	process.env.VALKEY_URL = "rediss://url-user:url%23password@url-host:6381/2";
	const client = clientFor();
	expect(client.options.host).toBe("url-host");
	expect(client.options.username).toBe("url-user");
	expect(client.options.password).toBe("url#password");
	expect(client.options.db).toBe(2);
	expect(client.options.tls).toBeDefined();
	client.disconnect();
});

test("an explicit URL without credentials does not inherit the component password", () => {
	process.env.VALKEY_PASSWORD = "component-secret";
	process.env.VALKEY_URL = "redis://other-host:6379";
	const client = clientFor();
	expect(client.options.host).toBe("other-host");
	expect(client.options.password).toBeNull();
	client.disconnect();
});

test("pubsub URL overrides the read URL without inheriting its credentials", () => {
	process.env.VALKEY_URL = "redis://:read-secret@read-host:6379";
	process.env.VALKEY_PASSWORD = "component-secret";
	const client = clientFor("redis://:pub%2Fsecret@pub-host:6382");
	expect(client.options.host).toBe("pub-host");
	expect(client.options.password).toBe("pub/secret");
	client.disconnect();
});
