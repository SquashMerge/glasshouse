import Redis from "ioredis";

let _valkey: Redis | null = null;

export function valkeyUrl(): string {
  return process.env.VALKEY_URL ??
    `redis://:${process.env.VALKEY_PASSWORD ?? ""}@${process.env.VALKEY_HOST ?? "localhost"}:${process.env.VALKEY_PORT ?? "6379"}`;
}

export function valkey(): Redis {
  if (_valkey) return _valkey;
  // Fall back to component vars so a missing VALKEY_URL doesn't drop the password
  // (which would NOAUTH-fail against a server started with --requirepass).
  _valkey = new Redis(valkeyUrl(), {
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
