import Redis from "ioredis";
import { valkeyUrl } from "./valkey.js";

const connectionHealthy = { publisher: true, subscriber: true };
let _publisher: Redis | null = null;
let _subscriber: Redis | null = null;
let _connectingPromise: Promise<void> | null = null;

export function valkeyPubSubHealthy(): boolean {
  return connectionHealthy.publisher && connectionHealthy.subscriber;
}

/**
 * Publish a JSON string on a channel. Returns immediately; ioredis buffers the
 * command on the offline queue (which we already disabled) or rejects if
 * disconnected. Either way we swallow the error so callers (the event bus)
 * can't be crashed by a Valkey blip.
 */
export async function publishOnChannel(channel: string, json: string): Promise<void> {
  try {
    const v = publisher();
    await v.publish(channel, json);
  } catch (err) {
    console.error(`[valkey-pubsub] publish to ${channel} failed:`, (err as Error).message);
  }
}

/**
 * Subscribe to a channel. Returns an unsubscribe fn. The handler is called
 * with the raw JSON string for each message; parsing is the caller's job.
 *
 * ioredis `subscribe` is idempotent per channel on the dedicated subscriber
 * connection; multiple handlers multiplex over its `message` event.
 */
export function subscribeToChannel(channel: string, handler: (json: string) => void): () => void {
  const v = subscriber();

  const onMessage = (ch: string, message: string) => {
    if (ch !== channel) return;
    try {
      handler(message);
    } catch (err) {
      console.error(`[valkey-pubsub] handler for ${channel} threw:`, (err as Error).message);
    }
  };
  v.on("message", onMessage);

  // Fire-and-forget subscribe. ioredis rejects on connection failure; we log
  // it but keep the handler attached so reconnects eventually wire it up.
  void v.subscribe(channel).catch((err: Error) => {
    console.error(`[valkey-pubsub] subscribe(${channel}) failed:`, err.message);
  });

  return () => {
    v.off("message", onMessage);
    void v.unsubscribe(channel).catch((err: Error) => {
      console.error(`[valkey-pubsub] unsubscribe(${channel}) failed:`, err.message);
    });
  };
}

function createClient(role: "publisher" | "subscriber"): Redis {
  const client = new Redis(process.env.VALKEY_PUBSUB_URL ?? valkeyUrl(), {
    enableOfflineQueue: role === "subscriber",
    maxRetriesPerRequest: 3,
    lazyConnect: role === "publisher",
  });
  client.on("error", (err: Error) => {
    connectionHealthy[role] = false;
    console.error(`[valkey-pubsub] ${role} error:`, err.message);
  });
  client.on("end", () => {
    connectionHealthy[role] = false;
  });
  client.on("ready", () => {
    connectionHealthy[role] = true;
  });
  client.on("reconnecting", () => {
    connectionHealthy[role] = false;
  });
  return client;
}

function publisher(): Redis {
  _publisher ??= createClient("publisher");
  return _publisher;
}

function subscriber(): Redis {
  _subscriber ??= createClient("subscriber");
  return _subscriber;
}

/**
 * Best-effort initial connect so the first publish doesn't pay the connect
 * tax. Called lazily from event-bus.ts the first time we publish. Idempotent.
 */
export async function ensureConnected(): Promise<void> {
  if (_connectingPromise) return _connectingPromise;
  _connectingPromise = (async () => {
    const v = publisher();
    if (v.status === "wait" || v.status === "end") {
      try {
        await v.connect();
        connectionHealthy.publisher = true;
      } catch (err) {
        connectionHealthy.publisher = false;
        console.error(`[valkey-pubsub] initial connect failed:`, (err as Error).message);
      }
    }
  })();
  return _connectingPromise;
}

/**
 * Test helper: force the bus to re-evaluate Valkey health on the next
 * publish. Only call from tests that mutate env after import.
 */
export function _resetForTests(): void {
  _publisher?.disconnect();
  _subscriber?.disconnect();
  _publisher = null;
  _subscriber = null;
  connectionHealthy.publisher = true;
  connectionHealthy.subscriber = true;
  _connectingPromise = null;
}
