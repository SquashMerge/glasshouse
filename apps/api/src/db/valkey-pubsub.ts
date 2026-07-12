// Thin wrappers around the lazy ioredis client in valkey.ts for pub/sub use.
// Errors are logged + swallowed so the SSE handler never 500s because the
// optional Valkey layer is down. Connection lifecycle events are logged at
// debug noise — they don't fan out to subscribers.

import Redis from "ioredis";
import { valkey } from "./valkey.js";

let _valkeyPubsubHealthy = true;
let _wiredEvents = false;
let _connectingPromise: Promise<void> | null = null;

export function valkeyPubSubHealthy(): boolean {
  return _valkeyPubsubHealthy;
}

/**
 * Publish a JSON string on a channel. Returns immediately; ioredis buffers the
 * command on the offline queue (which we already disabled) or rejects if
 * disconnected. Either way we swallow the error so callers (the event bus)
 * can't be crashed by a Valkey blip.
 */
export async function publishOnChannel(channel: string, json: string): Promise<void> {
  try {
    const v = ensureClient();
    await v.publish(channel, json);
  } catch (err) {
    console.error(`[valkey-pubsub] publish to ${channel} failed:`, (err as Error).message);
  }
}

/**
 * Subscribe to a channel. Returns an unsubscribe fn. The handler is called
 * with the raw JSON string for each message; parsing is the caller's job.
 *
 * We share the lazy singleton from valkey.ts. ioredis `subscribe` is idempotent
 * per channel on a single connection; multiple handlers multiplex over the
 * one `message` event.
 */
export function subscribeToChannel(channel: string, handler: (json: string) => void): () => void {
  const v = ensureClient();

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
  };
}

function ensureClient(): Redis {
  const v = valkey();
  if (!_wiredEvents) {
    v.on("error", (err: Error) => {
      _valkeyPubsubHealthy = false;
      console.error(`[valkey-pubsub] client error:`, err.message);
    });
    v.on("end", () => {
      _valkeyPubsubHealthy = false;
      console.error(`[valkey-pubsub] connection ended; reconnecting in background`);
    });
    v.on("ready", () => {
      _valkeyPubsubHealthy = true;
    });
    v.on("reconnecting", (delayMs: number) => {
      _valkeyPubsubHealthy = false;
      console.error(`[valkey-pubsub] reconnecting in ${delayMs}ms`);
    });
    _wiredEvents = true;
  }
  return v;
}

/**
 * Best-effort initial connect so the first publish doesn't pay the connect
 * tax. Called lazily from event-bus.ts the first time we publish. Idempotent.
 */
export async function ensureConnected(): Promise<void> {
  if (_connectingPromise) return _connectingPromise;
  _connectingPromise = (async () => {
    const v = valkey();
    if (v.status === "wait" || v.status === "end") {
      try {
        await v.connect();
        _valkeyPubsubHealthy = true;
      } catch (err) {
        _valkeyPubsubHealthy = false;
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
  _valkeyPubsubHealthy = true;
  _wiredEvents = false;
  _connectingPromise = null;
}