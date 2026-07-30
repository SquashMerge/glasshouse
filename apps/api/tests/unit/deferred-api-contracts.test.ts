import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openapiApp } from "../../src/openapi.js";

describe("deferred API contracts", () => {
	it("does not advertise unavailable agent and score endpoints", async () => {
		const response = await openapiApp.fetch(
			new Request("http://astraea.test/openapi.json"),
		);
		expect(response.status).toBe(200);
		const document = (await response.json()) as {
			paths: Record<string, unknown>;
		};

		expect(document.paths["/v1/agents"]).toBeUndefined();
		expect(document.paths["/v1/agents/{id}"]).toBeUndefined();
		expect(document.paths["/v1/scores"]).toBeUndefined();
	});

	it("does not describe deferred endpoints as smoke-tested product surfaces", () => {
		const smoke = readFileSync(
			resolve(import.meta.dir, "../../../../infra/scripts/smoke.sh"),
			"utf8",
		);
		expect(smoke).not.toContain("/v1/agents");
		expect(smoke).not.toContain("/v1/scores");
		expect(smoke).not.toContain("Unimplemented endpoints return 501");
	});
});
