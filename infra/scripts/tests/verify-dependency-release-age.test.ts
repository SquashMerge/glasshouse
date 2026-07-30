import { describe, expect, it } from "bun:test";
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
+    "@astraea/api": ["@astraea/api@workspace:apps/api"],
+`;

		expect(parseAddedPackageVersions(diff)).toEqual([
			{ name: "@scope/widget", version: "2.3.4" },
			{ name: "plain-package", version: "1.2.3" },
		]);
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
