// Valkey pub/sub tests for the event bus. These tests do NOT need a real
// Valkey instance — we mock valkey-pubsub.ts to simulate a shared channel
// registry so we can exercise the cross-instance / fallback / channel-
// isolation paths deterministically.
//
// Module-level state (channels, subscribers, publish log) is reset between
// tests so the order of cases doesn't matter.

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

type ValkeyHandler = (json: string) => void;

const channels: Map<string, Set<ValkeyHandler>> = new Map();
let publishFails = false;
const publishedCalls: Array<{ channel: string; json: string }> = [];

const valkeyPubsubMock = {
  publishOnChannel: mock(async (channel: string, json: string): Promise<void> => {
    if (publishFails) throw new Error("Valkey publish failed (test sim)");
    publishedCalls.push({ channel, json });
    const handlers = channels.get(channel);
    if (!handlers) return;
    for (const h of [...handlers]) {
      try {
        h(json);
      } catch (err) {
        console.error(`[valkey-pubsub mock] handler for ${channel} threw:`, (err as Error).message);
      }
    }
  }),
  subscribeToChannel: mock((channel: string, handler: ValkeyHandler): () => void => {
    let set = channels.get(channel);
    if (!set) {
      set = new Set();
      channels.set(channel, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) channels.delete(channel);
    };
  }),
  ensureConnected: mock(async () => undefined),
  valkeyPubSubHealthy: mock(() => true),
};

mock.module("../../src/db/valkey-pubsub", () => valkeyPubsubMock);

const { _resetForTests, _isValkeyEnabled, publishSync, subscribe, publish } = await import(
  "../../src/lib/event-bus"
);

beforeEach(() => {
  delete process.env.VALKEY_PUBSUB_URL;
  channels.clear();
  publishedCalls.length = 0;
  publishFails = false;
  valkeyPubsubMock.publishOnChannel.mockClear();
  valkeyPubsubMock.subscribeToChannel.mockClear();
  _resetForTests();
});

afterEach(() => {
  delete process.env.VALKEY_PUBSUB_URL;
  channels.clear();
  publishedCalls.length = 0;
  publishFails = false;
  _resetForTests();
});

describe("event-bus + Valkey pub/sub (mocked)", () => {
  it("toggle behavior: without VALKEY_PUBSUB_URL, publish never touches Valkey", async () => {
    expect(_isValkeyEnabled()).toBe(false);
    subscribe("trace.created", () => undefined);
    publishSync("trace.created", { trace: { trace_id: "t1" } as never });
    await new Promise((r) => setTimeout(r, 10));
    expect(valkeyPubsubMock.publishOnChannel).not.toHaveBeenCalled();
    expect(valkeyPubsubMock.subscribeToChannel).not.toHaveBeenCalled();
  });

  it("toggle behavior: with VALKEY_PUBSUB_URL set, publish DOES touch Valkey", async () => {
    process.env.VALKEY_PUBSUB_URL = "redis://mock:6379";
    const got: unknown[] = [];
    subscribe("trace.created", (m) => got.push(m));
    publishSync("trace.created", { trace: { trace_id: "t1" } as never });
    await new Promise((r) => setTimeout(r, 10));
    expect(valkeyPubsubMock.subscribeToChannel).toHaveBeenCalledTimes(1);
    expect(valkeyPubsubMock.publishOnChannel).toHaveBeenCalledTimes(1);
    expect(publishedCalls[0]?.channel).toBe("astraea:trace.created");
    // The local in-process dispatch fires once; the instance ignores its own
    // Valkey echo. Other instances accept the message because their origin differs.
    expect(got).toHaveLength(1);
  });

  it("toggle behavior: with VALKEY_PUBSUB_URL set to an unreachable host, the bus does not crash", async () => {
    process.env.VALKEY_PUBSUB_URL = "redis://nonexistent-host:6379";
    publishFails = true; // simulate connection failure inside publishOnChannel
    const got: unknown[] = [];
    subscribe("trace.created", (m) => got.push(m));
    // publishSync must NOT throw.
    expect(() =>
      publishSync("trace.created", { trace: { trace_id: "t1" } as never }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    // In-process dispatch still fires.
    expect(got).toHaveLength(1);
  });

  it("channel isolation: subscribers narrow to one channel each", async () => {
    process.env.VALKEY_PUBSUB_URL = "redis://mock:6379";
    const traceCalls: unknown[] = [];
    const obsCalls: unknown[] = [];
    const unsubscribeTrace = subscribe("trace.created", (m) => traceCalls.push(m));
    const unsubscribeObservation = subscribe("observation.created", (m) => obsCalls.push(m));

    publishSync("trace.created", { trace: { trace_id: "t1" } as never });
    publishSync("observation.created", { observation: { observation_id: "o1" } as never });
    await new Promise((r) => setTimeout(r, 10));

    expect(traceCalls).toHaveLength(1);
    expect(obsCalls).toHaveLength(1);
    // Each subscriber registered on its own Valkey channel.
    expect(channels.has("astraea:trace.created")).toBe(true);
    expect(channels.has("astraea:observation.created")).toBe(true);
    // Each publish landed on its own channel.
    const usedChannels = publishedCalls.map((c) => c.channel);
    expect(usedChannels).toContain("astraea:trace.created");
    expect(usedChannels).toContain("astraea:observation.created");

    unsubscribeTrace();
    expect(channels.has("astraea:trace.created")).toBe(false);
    expect(channels.has("astraea:observation.created")).toBe(true);
    unsubscribeObservation();
    expect(channels.has("astraea:observation.created")).toBe(false);
  });

  it("Valkey-down fallback: publishOnChannel throws, in-process still fires", async () => {
    process.env.VALKEY_PUBSUB_URL = "redis://mock:6379";
    publishFails = true;

    const inProcess: unknown[] = [];
    subscribe("trace.created", (m) => inProcess.push(m));
    publishSync("trace.created", { trace: { trace_id: "t1" } as never });
    await new Promise((r) => setTimeout(r, 10));

    // In-process must still fire even though Valkey publish threw.
    expect(inProcess).toHaveLength(1);
    // The publish was attempted (and the throw was swallowed by the bus).
    expect(valkeyPubsubMock.publishOnChannel).toHaveBeenCalledTimes(1);
  });

  it("Valkey-delivered messages are parsed and dispatched to in-process subscribers", async () => {
    process.env.VALKEY_PUBSUB_URL = "redis://mock:6379";
    const got: unknown[] = [];
    subscribe("trace.created", (m) => got.push(m));

    // Simulate a remote instance publishing by invoking the mock's
    // registered handlers directly (skipping the bus's own publish path).
    const handlers = Array.from(channels.get("astraea:trace.created") ?? []);
    expect(handlers.length).toBeGreaterThan(0);
    for (const h of handlers) {
      h(JSON.stringify({
        event: "trace.created",
        payload: { trace: { trace_id: "from-remote-instance" } },
      }));
    }
    expect(got).toHaveLength(1);
    expect((got[0] as { payload: { trace: { trace_id: string } } }).payload.trace.trace_id).toBe(
      "from-remote-instance",
    );
  });

  it("subscriber isolation: throwing handler on Valkey-delivered message doesn't kill peers", async () => {
    process.env.VALKEY_PUBSUB_URL = "redis://mock:6379";

    const orig = console.error;
    const logs: string[] = [];
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    // Register handlers AFTER subscribing (subscribe wires the Valkey handler).
    const goodCalls: unknown[] = [];
    const badHandler = () => {
      throw new Error("Valkey-delivered boom");
    };
    subscribe("trace.created", badHandler);
    subscribe("trace.created", (m) => goodCalls.push(m));

    // Get the bus-installed Valkey handler (the one registered by subscribe).
    // The mock's subscribeToChannel tracks handlers in `channels`.
    const handlers = Array.from(channels.get("astraea:trace.created") ?? []);
    // Exactly one bus-installed Valkey handler exists.
    expect(handlers.length).toBe(1);

    // Simulate a Valkey delivery from another instance.
    handlers[0]!(JSON.stringify({
      event: "trace.created",
      payload: { trace: { trace_id: "from-remote" } },
    }));

    // good handler received via Valkey-delivered path.
    expect(goodCalls).toHaveLength(1);
    expect(logs.some((l) => l.includes("Valkey-delivered boom"))).toBe(true);
    // badHandler was removed by the bus.
    // (We verify by re-delivering and confirming goodCalls increments by 1
    //  while no new error is logged.)
    const errsBefore = logs.filter((l) => l.includes("Valkey-delivered boom")).length;
    handlers[0]!(JSON.stringify({
      event: "trace.created",
      payload: { trace: { trace_id: "from-remote-2" } },
    }));
    expect(goodCalls).toHaveLength(2);
    const errsAfter = logs.filter((l) => l.includes("Valkey-delivered boom")).length;
    expect(errsAfter).toBe(errsBefore); // badHandler no longer throwing.

    console.error = orig;
  });

  it("publish() (async) also fans out to Valkey", async () => {
    process.env.VALKEY_PUBSUB_URL = "redis://mock:6379";
    subscribe("trace.created", () => undefined);
    await publish("trace.created", { trace: { trace_id: "t1" } as never });
    await new Promise((r) => setTimeout(r, 10));
    expect(valkeyPubsubMock.publishOnChannel).toHaveBeenCalledTimes(1);
  });

  it("payload shape on Valkey wire: { event, payload } with the publish() payload", async () => {
    process.env.VALKEY_PUBSUB_URL = "redis://mock:6379";
    subscribe("observation.created", () => undefined);
    publishSync("observation.created", {
      observation: { observation_id: "obs-123" } as never,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(publishedCalls).toHaveLength(1);
    const parsed = JSON.parse(publishedCalls[0]!.json);
    expect(parsed.event).toBe("observation.created");
    expect(parsed.payload.observation.observation_id).toBe("obs-123");
  });
});
