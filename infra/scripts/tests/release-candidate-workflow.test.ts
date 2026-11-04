import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

const root = resolve(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

it("runs the publisher's exact orchestration on non-publishing candidates", () => {
	const workflow = load(read(".github/workflows/release-candidate.yml")) as any;
	expect(Object.keys(workflow.on).sort()).toEqual([
		"pull_request",
		"push",
		"workflow_dispatch",
	]);
	expect(workflow.on.push.branches).toEqual(["main"]);
	expect(workflow.permissions).toEqual({ contents: "read" });
	const steps = workflow.jobs.candidate.steps as any[];
	for (const step of steps.filter((step) => step.uses))
		expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
	expect(steps[0].with.ref).toBe(
		"${{ github.event.pull_request.head.sha || github.sha }}",
	);
	const candidate = steps.find((step) =>
		step.run?.includes("test-publisher-candidate.sh"),
	);
	expect(candidate.env).toEqual({
		CANDIDATE_SHA: "${{ github.event.pull_request.head.sha || github.sha }}",
		VERSION: "v0.0.0-rc.1",
	});
	expect(candidate.run.trim()).toBe(
		"bash infra/scripts/test-publisher-candidate.sh",
	);
	const publisher = load(
		read(".github/workflows/release-publisher.yml"),
	) as any;
	expect(
		publisher.jobs["build-and-test"].steps.some(
			(step: any) => step.run?.trim() === candidate.run.trim(),
		),
	).toBe(true);
	const script = read("infra/scripts/test-publisher-candidate.sh");
	for (const fragment of [
		"export-release-image.py",
		"check-release-asset.py",
		"docker load",
		"release-image-scan.py",
		"test-release-upgrade.sh",
		"test-release-recovery.sh",
		"release-candidate-browser.ts",
		"release-candidate-authenticated.ts",
		"foreign-private-data",
		"GEPA_WORKER_MODE=fake",
		"migrations-before",
		"/v1/traces/events?project_id=",
		"candidate-sbom.json",
		'test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"',
	])
		expect(script).toContain(fragment);
	expect(script.indexOf("docker load")).toBeLessThan(
		script.indexOf("release-image-scan.py"),
	);
	expect(script).not.toMatch(/gh release|docker push|packages: write/);
});

it("transfers, attests and checksums the tested SBOM", () => {
	const workflow = load(read(".github/workflows/release-publisher.yml")) as any;
	const build = workflow.jobs["build-and-test"].steps as any[];
	const publish = workflow.jobs["publish-draft"].steps as any[];
	const transfer = build.find((step) =>
		step.uses?.startsWith("actions/upload-artifact@"),
	);
	const attestation = publish.find((step) =>
		step.uses?.startsWith("actions/attest-build-provenance@"),
	);
	expect(transfer.with.path).toContain(
		"${{ runner.temp }}/candidate-sbom.json",
	);
	expect(attestation.with["subject-path"]).toContain(
		"${{ runner.temp }}/release-assets/candidate-sbom.json",
	);
	const script = read("infra/scripts/test-publisher-candidate.sh");
	expect(script).toContain(
		"sha256sum glasshouse-image.tar.gz glasshouse-bundle.tar.gz candidate-sbom.json > SHA256SUMS",
	);
	expect(script).toContain("sha256sum --check sbom-before.SHA256SUMS");
});

it("probes tenant isolation with a mutation-capable subject and checks trace contents", () => {
	const browser = read("apps/web/tests/release-candidate-authenticated.ts");
	expect(browser).toContain('role: "admin"');
	expect(browser).toContain("candidate.admin");
	expect(browser).toContain("adminResult.localWrite");
	expect(browser).toContain("adminResult.foreignWrite");
	expect(browser).toContain("foreign-private-data");
	expect(browser).toContain("foreign-secret-trace");
});
