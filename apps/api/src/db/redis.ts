// Redis (ioredis) client + ping helper for /health.

import Redis from "ioredis";

let _redis: Redis | null = null;

export function redis(): Redis {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  _redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  return _redis;
}

export async function redisPing(): Promise<"up" | "down"> {
  try {
    const r = redis();
    const result = await r.ping();
    return result === "PONG" ? "up" : "down";
  } catch {
    return "down";
  }
}