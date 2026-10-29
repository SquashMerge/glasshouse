import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertReleaseAges,
	newlyLockedPackageVersions,
	type PackageVersion,
} from "../verify-dependency-release-age";

const registryRecord = (descriptor: string) => [
	descriptor,
	"",
	{},
	"sha512-example",
];
const lockfile = (packages: Record<string, unknown> = {}, space?: number) =>
	JSON.stringify(
		{
			lockfileVersion: 1,
			configVersion: 1,
			workspaces: { "apps/api": { name: "@glasshouse/api" } },
			packages,
		},
		null,
		space,
	);

describe("newlyLockedPackageVersions", () => {
	it("compares registry identities including aliases, scopes and nested versions", () => {
		const base = lockfile({
			"plain-package": registryRecord("plain-package@1.2.2"),
			"parent/duplicate": registryRecord("plain-package@1.2.3"),
		});
		const target = lockfile({
			"@scope/widget": registryRecord("@scope/widget@2.3.4"),
			"plain-package": registryRecord("plain-package@1.2.3"),
			alias: registryRecord("alias@npm:aliased-package@1.2.3"),
			"parent/alias": registryRecord("aliased-package@1.2.3"),
			"parent/old-version": registryRecord("plain-package@1.2.2"),
			"@glasshouse/api": ["@glasshouse/api@workspace:apps/api"],
		});

		expect(newlyLockedPackageVersions(base, target)).toEqual([
			{ name: "@scope/widget", version: "2.3.4" },
			{ name: "aliased-package", version: "1.2.3" },
		]);
	});

	it("checks a new version of an existing package", () => {
		expect(
			newlyLockedPackageVersions(
				lockfile({ widget: registryRecord("widget@1.0.0") }),
				lockfile({ widget: registryRecord("widget@1.0.1") }),
			),
		).toEqual([{ name: "widget", version: "1.0.1" }]);
	});

	const newPackages = { widget: registryRecord("widget@1.2.3") };
	for (const [format, target] of [
		["minified", lockfile(newPackages)],
		["multiline", lockfile(newPackages, 2)],
		[
			"JSONC with comments, trailing commas and split descriptor",
			`{
				"lockfileVersion": 1,
				"workspaces": {},
				"packages": { /* formatting is not a security boundary */
					"widget":
					[
						"widget@1.2.3", "", {}, "sha512-example",
					],
				},
			}`,
		],
	] as const) {
		it(`enforces mature and fresh release ages for ${format} additions`, async () => {
			const packages = newlyLockedPackageVersions(lockfile(), target);
			expect(packages).toEqual([{ name: "widget", version: "1.2.3" }]);
			const now = new Date("2026-10-20T00:00:00Z");
			await expect(
				assertReleaseAges(packages, 7, now, async () => new Date("2026-10-01")),
			).resolves.toBeUndefined();
			await expect(
				assertReleaseAges(packages, 7, now, async () => new Date("2026-10-19")),
			).rejects.toThrow("widget@1.2.3 was published less than");
		});
	}

	it("does not recheck removed, reordered or reformatted mature identities", () => {
		const base = lockfile(newPackages, 2);
		expect(newlyLockedPackageVersions(base, lockfile(newPackages))).toEqual([]);
		expect(newlyLockedPackageVersions(base, lockfile())).toEqual([]);
	});

	for (const packages of [
		{ widget: null },
		{ widget: {} },
		{ widget: [] },
		{ widget: [123] },
		{ widget: ["widget@1.2.3"] },
		{ widget: ["widget@1.2.3", "", {}, 123] },
		{ widget: ["widget@1.2.3", "", {}, "not-an-integrity"] },
		{
			widget: [
				"widget@1.2.3",
				"https://example.invalid/widget.tgz",
				{},
				"sha512-example",
			],
		},
		{ widget: ["widget@1.2.3", "", [], "sha512-example"] },
		{ widget: ["widget@git+https://example.invalid/widget.git"] },
		{ widget: ["widget@file:../widget"] },
		{ widget: ["widget@workspace:missing"] },
		{ widget: ["widget@workspace:apps/api"] },
		{ widget: ["@glasshouse/api@workspace:apps/api", "unexpected"] },
	]) {
		it("fails closed on unsupported package records in either revision", () => {
			expect(() =>
				newlyLockedPackageVersions(lockfile(), lockfile(packages)),
			).toThrow();
			expect(() =>
				newlyLockedPackageVersions(lockfile(packages), lockfile()),
			).toThrow();
		});
	}

	for (const unsupported of [
		"not JSONC",
		"null",
		"[]",
		"{}",
		'{"lockfileVersion":2,"workspaces":{},"packages":{}}',
		'{"lockfileVersion":1,"configVersion":2,"workspaces":{},"packages":{}}',
		'{"lockfileVersion":1,"workspaces":{},"packages":[]}',
		'{"lockfileVersion":1,"workspaces":{},"packages":null}',
		'{"lockfileVersion":1,"packages":{}}',
	]) {
		it("fails closed on an invalid or unsupported lockfile", () => {
			expect(() => newlyLockedPackageVersions(lockfile(), unsupported)).toThrow();
			expect(() => newlyLockedPackageVersions(unsupported, lockfile())).toThrow();
		});
	}

	it("parses the repository lockfile without introducing formatting-only additions", async () => {
		const current = await Bun.file(
			new URL("../../../bun.lock", import.meta.url),
		).text();
		expect(
			newlyLockedPackageVersions(
				current,
				JSON.stringify(Bun.JSONC.parse(current)),
			),
		).toEqual([]);
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

	it("fails closed when registry metadata has no valid publish timestamp", async () => {
		await expect(
			assertReleaseAges(packages, 7, now, async () => new Date("invalid")),
		).rejects.toThrow("npm did not provide a publish timestamp");
	});

	it("accepts the time-boxed security patch exception only until normal age enforcement applies", async () => {
		const securityPatch = [{ name: "brace-expansion", version: "5.0.9" }];
		const publishedAt = async () => new Date("2026-07-30T10:00:32.762Z");

		await expect(
			assertReleaseAges(
				securityPatch,
				7,
				new Date("2026-08-04T00:00:00.000Z"),
				publishedAt,
			),
		).resolves.toBeUndefined();

		await expect(
			assertReleaseAges(
				securityPatch,
				7,
				new Date("2026-08-06T10:00:32.762Z"),
				publishedAt,
			),
		).resolves.toBeUndefined();
	});

	it("permits the nanoid security repair only through its normal age window", async () => {
		const securityPatch = [{ name: "nanoid", version: "3.3.18" }];
		const publishedAt = async () => new Date("2026-08-07T16:41:05.696Z");

		await expect(
			assertReleaseAges(
				securityPatch,
				7,
				new Date("2026-08-14T16:41:05.695Z"),
				publishedAt,
			),
		).resolves.toBeUndefined();
		await expect(
			assertReleaseAges(
				securityPatch,
				7,
				new Date("2026-08-14T16:41:05.696Z"),
				publishedAt,
			),
		).resolves.toBeUndefined();
	});
});

describe("release-age CLI", () => {
	it("checks a stale pull request from its common merge base", () => {
		const repository = mkdtempSync(join(tmpdir(), "glasshouse-release-age-"));
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
			writeFileSync(join(repository, "bun.lock"), lockfile());
			run(["add", "bun.lock"]);
			run(["commit", "--quiet", "-m", "common"]);
			run(["branch", "feature"]);
			writeFileSync(
				join(repository, "bun.lock"),
				lockfile({
					"base-only-package": registryRecord("base-only-package@1.0.0"),
				}),
			);
			writeFileSync(join(repository, "README.md"), "base change\n");
			run(["add", "README.md", "bun.lock"]);
			run(["commit", "--quiet", "-m", "base"]);
			const baseSha = new TextDecoder()
				.decode(git(["rev-parse", "HEAD"]).stdout)
				.trim();
			run(["checkout", "--quiet", "feature"]);
			writeFileSync(
				join(repository, "package.json"),
				JSON.stringify({
					scripts: { "verify:dependency-release-age": "exit 99" },
				}),
			);
			writeFileSync(
				join(repository, "untrusted.ts"),
				"throw new Error('PR code executed');\n",
			);
			run(["add", "package.json", "untrusted.ts"]);
			run(["commit", "--quiet", "-m", "untrusted feature code"]);
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
			expect(new TextDecoder().decode(result.stdout)).toContain(
				"Verified 0 newly locked",
			);

			writeFileSync(join(repository, "bun.lock"), '{"packages":[]}');
			run(["add", "bun.lock"]);
			run(["commit", "--quiet", "-m", "unsupported lockfile"]);
			const invalid = Bun.spawnSync(
				[process.execPath, "run", verifier, baseSha, "HEAD"],
				{ cwd: repository },
			);
			expect(invalid.exitCode).not.toBe(0);
		} finally {
			rmSync(repository, { force: true, recursive: true });
		}
	});
});
