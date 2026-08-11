import { expect, test } from "bun:test";
import { createAuthorizedSseDelivery } from "../../src/lib/authorized-sse";

function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("a stalled trace writer drops queued heartbeat and later trace frames at the bounded queue cap", async () => {
	const started = deferred();
	const release = deferred();
	const writes: string[] = [];
	let cleaned = 0;
	const stream = {
		aborted: false,
		abort() {
			this.aborted = true;
		},
		onAbort() {},
		write: async () => {},
		writeSSE: async () => {},
	};
	const client = {
		query: async (sql: string) => {
			if (sql.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			return { rows: [{ id: "project" }] };
		},
		release() {},
	};
	const delivery = createAuthorizedSseDelivery({
		stream: stream as never,
		pool: () => ({ connect: async () => client }) as never,
		tenant: {
			actor: "member",
			actorId: "actor",
			organizationId: "organization",
		},
		projectId: "project",
		onClose: () => {
			cleaned += 1;
		},
		maxPendingFrames: 2,
		maxPendingBytes: 64,
	} as never);

	const first = delivery.deliver({
		bytes: 8,
		write: async () => {
			writes.push("trace-1");
			started.resolve();
			await release.promise;
		},
	} as never);
	await started.promise;
	const heartbeat = delivery.deliver({
		bytes: 8,
		write: async () => {
			writes.push("heartbeat");
		},
	} as never);
	const laterTrace = delivery.deliver({
		bytes: 8,
		write: async () => {
			writes.push("trace-2");
		},
	} as never);

	expect(delivery.closed).toBe(true);
	release.resolve();
	expect(await first).toBe(false);
	expect(await heartbeat).toBe(false);
	expect(await laterTrace).toBe(false);
	expect(writes).toEqual(["trace-1"]);
	expect(cleaned).toBe(1);
});

test("a stalled trace writer closes before retaining frames beyond the byte cap", async () => {
	const started = deferred();
	const release = deferred();
	const writes: string[] = [];
	const stream = {
		aborted: false,
		abort() {
			this.aborted = true;
		},
		onAbort() {},
		write: async () => {},
		writeSSE: async () => {},
	};
	const client = {
		query: async (sql: string) => {
			if (sql.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			return { rows: [{ id: "project" }] };
		},
		release() {},
	};
	const delivery = createAuthorizedSseDelivery({
		stream: stream as never,
		pool: () => ({ connect: async () => client }) as never,
		tenant: {
			actor: "member",
			actorId: "actor",
			organizationId: "organization",
		},
		projectId: "project",
		onClose: () => {},
		maxPendingFrames: 8,
		maxPendingBytes: 12,
	});
	const first = delivery.deliver({
		bytes: 8,
		write: async () => {
			writes.push("trace-1");
			started.resolve();
			await release.promise;
		},
	});
	await started.promise;
	const heartbeat = delivery.deliver({
		bytes: 8,
		write: async () => {
			writes.push("heartbeat");
		},
	});
	const laterTrace = delivery.deliver({
		bytes: 1,
		write: async () => {
			writes.push("trace-2");
		},
	});

	expect(delivery.closed).toBe(true);
	release.resolve();
	expect(await first).toBe(false);
	expect(await heartbeat).toBe(false);
	expect(await laterTrace).toBe(false);
	expect(writes).toEqual(["trace-1"]);
});

test("client cancellation releases a stalled frame and drops its queued heartbeat", async () => {
	const started = deferred();
	const release = deferred();
	let cancelClient: () => void = () => undefined;
	let cleaned = 0;
	const stream = {
		aborted: false,
		abort() {
			this.aborted = true;
		},
		onAbort(callback: () => void) {
			cancelClient = callback;
		},
		write: async () => {},
		writeSSE: async () => {},
	};
	const client = {
		query: async (sql: string) => {
			if (sql.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			return { rows: [{ id: "project" }] };
		},
		release() {},
	};
	const delivery = createAuthorizedSseDelivery({
		stream: stream as never,
		pool: () => ({ connect: async () => client }) as never,
		tenant: {
			actor: "member",
			actorId: "actor",
			organizationId: "organization",
		},
		projectId: "project",
		onClose: () => {
			cleaned += 1;
		},
	});
	const first = delivery.deliver({
		bytes: 8,
		write: async () => {
			started.resolve();
			await release.promise;
		},
	});
	await started.promise;
	const heartbeat = delivery.deliver({
		bytes: 8,
		write: async () => {},
	});

	cancelClient();
	expect(await first).toBe(false);
	expect(await heartbeat).toBe(false);
	expect(delivery.closed).toBe(true);
	expect(cleaned).toBe(1);
	release.resolve();
});

test("write timeout releases a stalled frame without retaining it", async () => {
	const started = deferred();
	const release = deferred();
	let cleaned = 0;
	const stream = {
		aborted: false,
		abort() {
			this.aborted = true;
		},
		onAbort() {},
		write: async () => {},
		writeSSE: async () => {},
	};
	const client = {
		query: async (sql: string) => {
			if (sql.startsWith("SELECT authorization_allows_project"))
				return { rows: [{ allowed: true }] };
			return { rows: [{ id: "project" }] };
		},
		release() {},
	};
	const delivery = createAuthorizedSseDelivery({
		stream: stream as never,
		pool: () => ({ connect: async () => client }) as never,
		tenant: {
			actor: "member",
			actorId: "actor",
			organizationId: "organization",
		},
		projectId: "project",
		onClose: () => {
			cleaned += 1;
		},
		timeoutMs: 1,
	});
	const stalled = delivery.deliver({
		bytes: 8,
		write: async () => {
			started.resolve();
			await release.promise;
		},
	});
	await started.promise;

	expect(await stalled).toBe(false);
	expect(delivery.closed).toBe(true);
	expect(cleaned).toBe(1);
	release.resolve();
});
