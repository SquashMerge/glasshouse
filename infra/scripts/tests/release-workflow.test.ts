import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as yaml from "js-yaml";

const workflowPath = new URL(
	"../../../.github/workflows/release.yml",
	import.meta.url,
);
describe("release workflow", () => {
	test("runs on pull requests and version tags with read-only default permissions", () => {
		const workflow = yaml.load(readFileSync(workflowPath, "utf8")) as any;
		expect(workflow.on.pull_request).toBeDefined();
		expect(workflow.on.push.tags).toContain("v*");
		expect(workflow.permissions.contents).toBe("read");
	});
	test("builds, saves, reloads and tests the same image before publishing", () => {
		const workflow = yaml.load(readFileSync(workflowPath, "utf8")) as any;
		const commands = workflow.jobs.build.steps
			.map((s: any) => s.run || "")
			.join("\n");
		expect(commands).toContain("docker build");
		expect(commands).toContain("docker save");
		expect(commands).toContain("docker load");
		expect(commands).toContain("test-release-image.sh");
		expect(workflow.jobs.publish.needs).toContain("build");
	});
	test("creates a draft using the existing verified tag without clobbering", () => {
		const workflow = yaml.load(readFileSync(workflowPath, "utf8")) as any;
		const commands = workflow.jobs.publish.steps
			.map((s: any) => s.run || "")
			.join("\n");
		expect(commands).toContain("gh release create");
		for (const flag of ["--verify-tag", "--draft", "--generate-notes"])
			expect(commands).toContain(flag);
		expect(commands).not.toContain("--clobber");
	});
	test("the publication job only runs on version tag pushes", () => {
		const workflow = yaml.load(readFileSync(workflowPath, "utf8")) as any;
		expect(workflow.jobs.publish.if).toContain("github.event_name == 'push'");
		expect(workflow.jobs.publish.if).toContain("refs/tags/");
		expect(workflow.jobs.publish.permissions.contents).toBe("write");
	});
});
