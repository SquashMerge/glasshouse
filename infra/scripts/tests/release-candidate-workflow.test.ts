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

it("runs the fake-provider lifecycle on the exact reloaded release artifact", () => {
	const candidate = read("infra/scripts/test-publisher-candidate.sh");
	const lifecycle = candidate.indexOf(
		"bash infra/scripts/test-release-candidate-evaluation.sh",
	);
	expect(lifecycle).toBeGreaterThan(candidate.indexOf("docker load"));
	expect(lifecycle).toBeLessThan(
		candidate.indexOf(
			"sha256sum glasshouse-image.tar.gz glasshouse-bundle.tar.gz candidate-sbom.json > SHA256SUMS",
		),
	);
	const script = read("infra/scripts/test-release-candidate-evaluation.sh");
	for (const fragment of [
		"NODE_ENV: test",
		"GLASSHOUSE_EVAL_LLM_PROVIDER: fake",
		"EVALUATION_ALLOWED_MODELS: fake/deterministic",
		'OPENAI_API_KEY: ""',
		"--no-build --pull never",
		"release-candidate-evaluation.ts",
		"CANDIDATE_READBACK_FILE",
		"restart api",
		"{{.Image}}",
	])
		expect(script).toContain(fragment);
	expect(script.indexOf("CANDIDATE_EXPECT_FAKE_DENIAL=true")).toBeLessThan(
		script.indexOf("NODE_ENV: test"),
	);
	expect(script).toContain("org.opencontainers.image.revision");
	expect(script).not.toContain("NODE_ENV: production");
	expect(read("deploy/release/compose.yaml")).toContain("NODE_ENV: production");
});

it("runs and re-reads the real GEPA subprocess lifecycle only in the isolated test stack", () => {
	const script = read("infra/scripts/test-release-candidate-evaluation.sh");
	const testMode = script.indexOf("NODE_ENV: test");
	const fake = script.indexOf("GEPA_WORKER_MODE: fake");
	const first = script.indexOf("bun /candidate-scripts/release-candidate-gepa.ts");
	const restart = script.indexOf('"${compose[@]}" restart api');
	const readback = script.lastIndexOf(
		"bun /candidate-scripts/release-candidate-gepa.ts",
	);
	expect(testMode).toBeGreaterThan(
		script.indexOf("CANDIDATE_EXPECT_FAKE_DENIAL=true"),
	);
	expect(fake).toBeGreaterThan(testMode);
	expect(first).toBeGreaterThan(fake);
	expect(restart).toBeGreaterThan(first);
	expect(readback).toBeGreaterThan(restart);
	expect(script.slice(restart, readback)).toContain("CANDIDATE_READBACK_FILE");
});

it("runs the real GEPA path against an isolated HTTP fixture and reads it back", () => {
	const script = read("infra/scripts/test-release-candidate-evaluation.sh");
	for (const fragment of [
		"internal: true",
		"GEPA_WORKER_MODE: gepa",
		"OPENAI_API_KEY: synthetic-gepa-key",
		"OPENAI_API_BASE: http://fixture:8080/v1",
		"task_seed",
		"task_candidate",
		"reflection",
		"/candidate-state/gepa-real.json",
	]) expect(script).toContain(fragment);
	const first = script.indexOf("CANDIDATE_REAL_GEPA=true");
	const restart = script.indexOf('"${compose[@]}" restart api');
	const readback = script.lastIndexOf("CANDIDATE_REAL_GEPA=true");
	expect(first).toBeLessThan(restart);
	expect(readback).toBeGreaterThan(restart);
	expect(script.slice(readback)).toContain("CANDIDATE_READBACK_FILE");
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
