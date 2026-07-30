import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertReleaseAges,
	type PackageVersion,
	parseAddedPackageVersions,
} from "../verify-dependency-release-age";

describe("parseAddedPackageVersions", () => {
	it("collects newly added public package records and ignores workspace records", () => {
		const diff = `diff --git a/bun.lock b/bun.lock
++++ b/bun.lock
+    "@scope/widget": ["@scope/widget@2.3.4", "", {}, "sha512-example"],
+    "plain-package": ["plain-package@1.2.3", "", {}, "sha512-example"],
+    "alias": ["alias@npm:aliased-package@1.2.3", "", {}, "sha512-example"],
+    "@astraea/api": ["@astraea/api@workspace:apps/api"],
+`;

		expect(parseAddedPackageVersions(diff)).toEqual([
			{ name: "@scope/widget", version: "2.3.4" },
			{ name: "aliased-package", version: "1.2.3" },
			{ name: "plain-package", version: "1.2.3" },
		]);
	});

	it("fails closed for an unsupported non-workspace descriptor", () => {
		const diff =
			'+    "package": ["package@git+https://example.invalid/package.git"]';

		expect(() => parseAddedPackageVersions(diff)).toThrow(
			"Unsupported non-registry lockfile descriptor",
		);
	});
});

describe("assertReleaseAges", () => {
	const now = new Date("2026-07-30T12:00:00.000Z");
	const packages: PackageVersion[] = [
		{ name: "established-package", version: "1.0.0" },
		{ name: "new-package", version: "2.0.0" },
	];

	it("accepts releases at least seven days old", async () => {
		await expect(
			assertReleaseAges(
				packages.slice(0, 1),
				7,
				now,
				async () => new Date("2026-07-23T12:00:00.000Z"),
			),
		).resolves.toBeUndefined();
	});

	it("rejects a newly released package with an actionable error", async () => {
		await expect(
			assertReleaseAges(packages, 7, now, async (pkg) =>
				pkg.name === "new-package"
					? new Date("2026-07-30T11:59:59.000Z")
					: new Date("2026-07-01T00:00:00.000Z"),
			),
		).rejects.toThrow(
			"new-package@2.0.0 was published less than the required 7 days ago",
		);
	});
});

describe("release-age CLI", () => {
	it("checks a stale pull request from its common merge base", () => {
		const repository = mkdtempSync(join(tmpdir(), "astraea-release-age-"));
		try {
			const git = (args: string[]) =>
				Bun.spawnSync(["git", ...args], { cwd: repository });
			const run = (args: string[]) => {
				const result = git(args);
				if (result.exitCode !== 0) {
					throw new Error(new TextDecoder().decode(result.stderr));
				}
			};

			run(["init", "--quiet"]);
			run(["config", "user.name", "test"]);
			run(["config", "user.email", "test@example.invalid"]);
			writeFileSync(join(repository, "bun.lock"), '{\n  "packages": {}\n}\n');
			run(["add", "bun.lock"]);
			run(["commit", "--quiet", "-m", "common"]);
			run(["branch", "feature"]);
			writeFileSync(join(repository, "README.md"), "base change\n");
			run(["add", "README.md"]);
			run(["commit", "--quiet", "-m", "base"]);
			const baseSha = new TextDecoder()
				.decode(git(["rev-parse", "HEAD"]).stdout)
				.trim();
			run(["checkout", "--quiet", "feature"]);
			const targetSha = new TextDecoder()
				.decode(git(["rev-parse", "HEAD"]).stdout)
				.trim();

			const verifier = new URL(
				"../verify-dependency-release-age.ts",
				import.meta.url,
			).pathname;
			const result = Bun.spawnSync(
				[process.execPath, "run", verifier, baseSha, targetSha],
				{ cwd: repository },
			);

			expect(result.exitCode).toBe(0);
		} finally {
			rmSync(repository, { force: true, recursive: true });
		}
	});
});
