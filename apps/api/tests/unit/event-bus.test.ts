import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
	_resetForTests,
	_isValkeyEnabled,
	publishSync,
	subscribe,
} from "../../src/lib/event-bus";

beforeEach(() => {
	delete process.env.VALKEY_PUBSUB_URL;
	_resetForTests();
});

afterEach(() => {
	delete process.env.VALKEY_PUBSUB_URL;
	_resetForTests();
});

describe("event-bus (in-process only)", () => {
	it("publish reaches a single subscriber", () => {
		const got: unknown[] = [];
		subscribe("trace.created", (msg) => got.push(msg));
		publishSync("trace.created", { trace: { trace_id: "t1" } as never });
		expect(got).toHaveLength(1);
		expect((got[0] as { event: string }).event).toBe("trace.created");
	});

	it("publish reaches multiple subscribers", () => {
		const a: unknown[] = [];
		const b: unknown[] = [];
		subscribe("trace.created", (msg) => a.push(msg));
		subscribe("trace.created", (msg) => b.push(msg));
		publishSync("trace.created", { trace: { trace_id: "t1" } as never });
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
	});

	it("publish is channel-scoped (trace.created does not fire observation.created)", () => {
		const traces: unknown[] = [];
		const obs: unknown[] = [];
		subscribe("trace.created", (msg) => traces.push(msg));
		subscribe("observation.created", (msg) => obs.push(msg));
		publishSync("trace.created", { trace: { trace_id: "t1" } as never });
		publishSync("observation.created", {
			observation: { observation_id: "o1" } as never,
		});
		expect(traces).toHaveLength(1);
		expect(obs).toHaveLength(1);
	});

	it("unsubscribe stops further deliveries", () => {
		const got: unknown[] = [];
		const unsub = subscribe("trace.created", (msg) => got.push(msg));
		publishSync("trace.created", { trace: { trace_id: "t1" } as never });
		unsub();
		publishSync("trace.created", { trace: { trace_id: "t2" } as never });
		expect(got).toHaveLength(1);
	});

	it("calling unsubscribe twice is a no-op", () => {
		const got: unknown[] = [];
		const unsub = subscribe("trace.created", (msg) => got.push(msg));
		unsub();
		expect(() => unsub()).not.toThrow();
	});

	it("a throwing handler is logged and removed; siblings still fire", () => {
		const orig = console.error;
		const logs: string[] = [];
		console.error = (...args: unknown[]) =>
			logs.push(args.map(String).join(" "));

		const fired: unknown[] = [];
		const badHandler = () => {
			throw new Error("boom");
		};
		subscribe("trace.created", badHandler);
		subscribe("trace.created", (msg) => fired.push(msg));

		publishSync("trace.created", { trace: { trace_id: "t1" } as never });
		expect(fired).toHaveLength(1);
		expect(
			logs.some((l) => l.includes("handler for trace.created threw")),
		).toBe(true);

		// After the throw, badHandler should be removed.
		publishSync("trace.created", { trace: { trace_id: "t2" } as never });
		// fired now has 2 (sibling still alive), and badHandler did not throw again.
		expect(fired).toHaveLength(2);
		console.error = orig;
	});

	it("publish is synchronous for in-process subscribers", () => {
		let observed = 0;
		subscribe("trace.created", () => {
			observed++;
		});
		publishSync("trace.created", { trace: { trace_id: "t1" } as never });
		expect(observed).toBe(1);
	});

	it("publish with no subscribers is a no-op (no throw)", () => {
		expect(() =>
			publishSync("trace.created", { trace: { trace_id: "t1" } as never }),
		).not.toThrow();
	});

	it("different events use different Sets (cross-event isolation)", () => {
		const got: string[] = [];
		subscribe("trace.created", (msg) =>
			got.push((msg.payload.trace as { trace_id: string }).trace_id),
		);
		subscribe("observation.created", (msg) =>
			got.push(
				(msg.payload.observation as { observation_id: string }).observation_id,
			),
		);
		publishSync("trace.created", { trace: { trace_id: "abc" } as never });
		publishSync("observation.created", {
			observation: { observation_id: "xyz" } as never,
		});
		expect(got).toEqual(["abc", "xyz"]);
	});

	it("isValkeyEnabled returns false without VALKEY_PUBSUB_URL", () => {
		expect(_isValkeyEnabled()).toBe(false);
	});
});
