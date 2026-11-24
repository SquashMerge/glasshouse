import Redis from "ioredis";

let _valkey: Redis | null = null;

export function valkeyConnection(url = process.env.VALKEY_URL): {
	url: string;
	password?: string;
} {
	if (url !== undefined) return { url };
	return {
		url: `redis://${process.env.VALKEY_HOST ?? "localhost"}:${process.env.VALKEY_PORT ?? "6379"}`,
		password: process.env.VALKEY_PASSWORD ?? "",
	};
}

export function valkey(): Redis {
	if (_valkey) return _valkey;
	const { url, password } = valkeyConnection();
	_valkey = new Redis(url, {
		...(password !== undefined ? { password } : {}),
		enableOfflineQueue: false,
		maxRetriesPerRequest: 3,
		lazyConnect: true,
	});
	return _valkey;
}

export async function valkeyPing(): Promise<"up" | "down"> {
	try {
		const v = valkey();
		const result = await v.ping();
		return result === "PONG" ? "up" : "down";
	} catch {
		return "down";
	}
}
