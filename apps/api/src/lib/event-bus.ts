// In-process pub/sub with optional Valkey (Redis-compatible) fan-out.
// Single-node MVP: in-process `Map<event, Set<Handler>>` always runs.
// When VALKEY_PUBSUB_URL is set, publishes ALSO fan out to a per-event
// channel and subscribers ALSO listen on that channel — so two apiApp
// instances sharing a Valkey see each other's writes. Wire format:
//   { "event": "trace.created", "payload": { ... } }
//
// Failure isolation:
//   - Valkey down at startup or runtime: log once, keep in-process only.
//   - A throwing handler is logged and removed; siblings still fire.
//   - publish() itself never throws to its caller.

import type { TraceRow, ObservationRow } from "../db/traces-query.js";
import { ensureConnected, publishOnChannel, subscribeToChannel, valkeyPubSubHealthy } from "../db/valkey-pubsub.js";

export type BusEvent = "trace.created" | "observation.created";

export interface BusMessage {
  event: BusEvent;
  payload: { trace?: TraceRow; observation?: ObservationRow };
}

export type BusHandler = (msg: BusMessage) => void;

const CHANNEL_PREFIX = "astraea:";

const handlers: Map<BusEvent, Set<BusHandler>> = new Map();

// One Valkey subscription per channel, shared by all in-process subscribers.
// Refcount lets us add/remove the wire-level listener as subscribers come and
// go. Internal only — `subscribe()` is the public API.
let valkeyChannelRefcount = 0;
const valkeyUnsubs: Map<BusEvent, () => void> = new Map();

function channelFor(event: BusEvent): string {
  return `${CHANNEL_PREFIX}${event}`;
}

function isValkeyEnabled(): boolean {
  return Boolean(process.env.VALKEY_PUBSUB_URL);
}

/**
 * Publish to all in-process subscribers and (optionally) to the Valkey
 * channel. Never throws. Async return for the Valkey leg so callers that
 * care can await it; not required for the in-process leg.
 */
export async function publish(event: BusEvent, payload: BusMessage["payload"]): Promise<void> {
  const msg: BusMessage = { event, payload };
  dispatchInProcess(msg);
  fanOutToValkey(event, msg);
}

/**
 * Synchronous publish for call sites that don't await. Equivalent to
 * `publish()` with the return value discarded.
 */
export function publishSync(event: BusEvent, payload: BusMessage["payload"]): void {
  const msg: BusMessage = { event, payload };
  dispatchInProcess(msg);
  fanOutToValkey(event, msg);
}

function dispatchInProcess(msg: BusMessage): void {
  const set = handlers.get(msg.event);
  if (!set || set.size === 0) return;
  // Snapshot to allow handlers to mutate the set (a throwing handler gets
  // removed mid-iteration).
  for (const h of [...set]) {
    try {
      h(msg);
    } catch (err) {
      console.error(`[event-bus] handler for ${msg.event} threw:`, (err as Error).message);
      set.delete(h);
    }
  }
}

/**
 * Best-effort Valkey fan-out. Never throws; never returns a rejected promise.
 * The real `publishOnChannel` wrapper already swallows ioredis errors, but
 * we add an outer `.catch` so a misbehaving mock or a missing wrapper
 * doesn't generate unhandled-rejection warnings at the call site.
 */
function fanOutToValkey(event: BusEvent, msg: BusMessage): void {
  if (!isValkeyEnabled()) return;
  void ensureConnected()
    .then(() => publishOnChannel(channelFor(event), JSON.stringify(msg)))
    .catch((err: Error) => {
      console.error(`[event-bus] valkey fan-out for ${event} failed:`, err.message);
    });
}

/**
 * Subscribe to an event. Returns an unsubscribe fn.
 *
 * Valkey subscribers are wired lazily — the first subscriber on a channel
 * opens the wire-level `subscribe()` and any subsequent in-process
 * subscribers share that one wire connection. When the last subscriber
 * unsubscribes, the wire-level listener is removed (best-effort; ioredis
 * keeps the SUBSCRIBE state, but we drop our handler so we stop fanning
 * into in-process handlers).
 */
export function subscribe(event: BusEvent, handler: BusHandler): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(handler);

  if (isValkeyEnabled() && !valkeyUnsubs.has(event)) {
    const unsub = subscribeToChannel(channelFor(event), (json) => {
      let parsed: BusMessage;
      try {
        parsed = JSON.parse(json) as BusMessage;
      } catch (err) {
        console.error(`[event-bus] failed to parse ${event} from valkey:`, (err as Error).message);
        return;
      }
      // Same isolation rule as the in-process leg.
      const s = handlers.get(event);
      if (!s || s.size === 0) return;
      for (const h of [...s]) {
        try {
          h(parsed);
        } catch (err) {
          console.error(`[event-bus] handler for ${event} (valkey) threw:`, (err as Error).message);
          s.delete(h);
        }
      }
    });
    valkeyUnsubs.set(event, unsub);
    valkeyChannelRefcount++;
  } else if (isValkeyEnabled()) {
    valkeyChannelRefcount++;
  }

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    const s = handlers.get(event);
    if (s) {
      s.delete(handler);
      if (s.size === 0) handlers.delete(event);
    }
    if (!isValkeyEnabled()) return;
    valkeyChannelRefcount--;
    if (valkeyChannelRefcount <= 0) {
      const unsub = valkeyUnsubs.get(event);
      if (unsub) {
        try {
          unsub();
        } catch {
          /* best effort */
        }
        valkeyUnsubs.delete(event);
      }
      valkeyChannelRefcount = 0;
    }
  };
}

/** Test helper: reset all internal state. Not for production use. */
export function _resetForTests(): void {
  for (const set of handlers.values()) set.clear();
  handlers.clear();
  for (const unsub of valkeyUnsubs.values()) {
    try {
      unsub();
    } catch {
      /* best effort */
    }
  }
  valkeyUnsubs.clear();
  valkeyChannelRefcount = 0;
}

/** Test helper: re-evaluate Valkey availability based on current env. */
export function _isValkeyEnabled(): boolean {
  return isValkeyEnabled();
}

/** Re-export for tests / health endpoints. */
export { valkeyPubSubHealthy };