import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

it("candidate CI is non-publishing and reloads the compressed image", () => {
	const root = resolve(import.meta.dir, "../../..");
	const workflow = load(
		readFileSync(
			resolve(root, ".github/workflows/release-candidate.yml"),
			"utf8",
		),
	) as any;
	expect(Object.keys(workflow.on).sort()).toEqual([
		"pull_request",
		"push",
		"workflow_dispatch",
	]);
	expect(workflow.on.push.branches).toEqual(["main"]);
	expect(workflow.permissions).toEqual({ contents: "read" });
	const steps = workflow.jobs.candidate.steps as {
		uses?: string;
		run?: string;
	}[];
	for (const step of steps.filter((step) => step.uses)) {
		expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
	}
	const commands = steps.map((step) => step.run ?? "").join("\n");
	expect(commands).toContain("export-release-image.py");
	expect(commands).toContain("check-release-asset.py");
	expect(commands).toContain("docker load");
	expect(commands).toContain("python3 scripts/install_snapshot_trivy.py");
	expect(commands).toContain(
		'python3 infra/scripts/release-image-scan.py "$image" "$before"',
	);
	expect(commands.indexOf("docker load")).toBeLessThan(
		commands.indexOf("python3 infra/scripts/release-image-scan.py"),
	);
	expect(
		commands.indexOf("python3 infra/scripts/release-image-scan.py"),
	).toBeLessThan(commands.indexOf('"${compose[@]}" up -d --no-build'));
	expect(
		commands.match(/sha256sum --check candidate\.SHA256SUMS/g),
	).toHaveLength(2);
	expect(commands).toContain("synthetic-owner:synthetic-ui-9b412e8cfa");
	expect(workflow.jobs.candidate.steps[0].with.ref).toBe(
		"${{ github.event.pull_request.head.sha || github.sha }}",
	);
	expect(commands).toContain('test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"');
	const afterRestart = commands.split('"${compose[@]}" restart api')[1];
	expect(afterRestart).toMatch(
		/address=.*port api 3000[\s\S]*curl.*\$address\/v1\/health/,
	);
	expect(commands).toContain("migrations-before");
	expect(commands).toContain("/v1/traces/events?project_id=");
	expect(commands).toContain(
		'infra/scripts/test-release-upgrade.sh "$bundle" "$project" "$before"',
	);
	expect(commands).toContain(
		'infra/scripts/test-release-recovery.sh "$bundle" "$project" "$before"',
	);
	expect(commands).toContain("bun apps/web/tests/release-candidate-browser.ts");
	expect(commands).toContain(
		"bun apps/web/tests/release-candidate-authenticated.ts",
	);
	expect(commands).toContain("foreign-private-data");
	expect(commands).toContain("GEPA_WORKER_MODE=fake");
	expect(commands).toContain("GLASSHOUSE_IMAGE=%s");
	expect(commands).toContain(
		'docker run --rm --entrypoint /opt/gepa/bin/python "$before"',
	);
	expect(commands).not.toMatch(/gh release|docker push|packages: write/);
});
