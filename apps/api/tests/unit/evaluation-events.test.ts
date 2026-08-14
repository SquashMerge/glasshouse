import { describe, expect, it } from "bun:test";
import { createExperimentHandlers } from "../../src/routes/experiments";

const projectId = "11111111-1111-4111-8111-111111111111";
const experimentId = "33333333-3333-4333-8333-333333333333";

describe("evaluation event stream", () => {
	it("serializes slow status polls and cancels cleanly", async () => {
		let calls = 0;
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handlers = createExperimentHandlers({
			pool: () =>
				({
					connect: async () => ({
						query: async () => ({ rows: [{ id: projectId, allowed: true }] }),
						release() {},
					}),
					query: async () => ({
						rows: [
							{
								effective_role: "admin",
								enforcement: "strict",
								project_status: "active",
								allowed: true,
							},
						],
					}),
				}) as never,
			getExperiment: async () => {
				calls += 1;
				if (calls > 1) await blocked;
				return { status: "running", project_id: projectId } as never;
			},
		} as never);
		const response = await handlers.handleGetExperimentEvents({
			req: {
				valid: (key: string) =>
					key === "param" ? { id: experimentId } : { project_id: projectId },
			},
			get: () => ({
				actor: "owner",
				actorId: "22222222-2222-4222-8222-222222222222",
				organizationId: "00000000-0000-4000-8000-000000000001",
			}),
			header: () => {},
			newResponse: (body: BodyInit | null, init?: ResponseInit) =>
				new Response(body, init),
			json: (body: unknown, status?: number) =>
				new Response(JSON.stringify(body), { status }),
		} as never);
		const reader = response.body?.getReader();

		await Bun.sleep(1_100);
		expect(calls).toBe(2);
		await expect(reader?.cancel()).resolves.toBeUndefined();
		release();
	});
});
