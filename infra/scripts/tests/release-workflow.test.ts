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
		expect(commands).toContain("gzip -n");
		expect(commands).toContain("less than GitHub's 2 GiB release asset limit");
		expect(commands).toContain("test-release-image.sh");
		expect(commands).toContain("glasshouse-image.tar.gz");
		expect(commands).toContain("test_create_draft_release");
		expect(workflow.jobs.publish.needs).toContain("build");
	});
	test("creates a draft using the existing verified tag without clobbering", () => {
		const workflow = yaml.load(readFileSync(workflowPath, "utf8")) as any;
		const commands = workflow.jobs.publish.steps
			.map((s: any) => s.run || "")
			.join("\n");
		expect(commands).toContain("create-draft-release.sh");
		expect(commands).not.toContain("--clobber");
		expect(commands).toContain("sha256sum -c SHA256SUMS");
	});
	test("loads the guard script in the separate publication job", () => {
		const workflow = yaml.load(readFileSync(workflowPath, "utf8")) as any;
		expect(
			workflow.jobs.publish.steps.some((step: any) =>
				step.uses?.startsWith("actions/checkout@"),
			),
		).toBe(true);
	});
	test("installs Chromium for the release image browser journey", () => {
		const workflow = yaml.load(readFileSync(workflowPath, "utf8")) as any;
		expect(
			workflow.jobs.build.steps.map((step: any) => step.run || "").join("\n"),
		).toContain("playwright install --with-deps chromium");
	});
	test("serializes publication attempts for each tag", () => {
		const workflow = yaml.load(readFileSync(workflowPath, "utf8")) as any;
		expect(workflow.concurrency.group).toContain("github.ref");
		expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
	});
	test("the publication job only runs on version tag pushes", () => {
		const workflow = yaml.load(readFileSync(workflowPath, "utf8")) as any;
		expect(workflow.jobs.publish.if).toContain("github.event_name == 'push'");
		expect(workflow.jobs.publish.if).toContain("refs/tags/");
		expect(workflow.jobs.publish.permissions.contents).toBe("write");
	});
});
