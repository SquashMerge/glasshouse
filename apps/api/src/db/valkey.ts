// Valkey client (wire-compatible with Redis 7.2+).
// Valkey is the open-source fork of Redis maintained by the Linux Foundation;
// the protocol and command set are identical to Redis 7.2+, so ioredis works
// unchanged. https://valkey.io

import Redis from "ioredis";

let _valkey: Redis | null = null;

export function valkey(): Redis {
  if (_valkey) return _valkey;
  const url = process.env.VALKEY_URL ?? "redis://localhost:6379";
  _valkey = new Redis(url, {
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