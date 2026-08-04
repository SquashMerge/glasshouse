export type PackageVersion = {
	name: string;
	version: string;
};

const MINIMUM_RELEASE_AGE_DAYS = 7;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

// CVE-2026-69152 is a high-severity denial-of-service vulnerability in the
// transitive migration dependency. The exception ends at the exact point where
// the normal seven-day policy accepts the upstream 5.0.9 security patch.
const TEMPORARY_SECURITY_RELEASE_AGE_EXCEPTIONS = new Map([
	["brace-expansion@5.0.9", new Date("2026-08-06T10:00:32.762Z")],
]);
const packageName = String.raw`(?:@[^/]+/[^@]+|[^@]+)`;
const version = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const directDescriptor = new RegExp(
	`^(?<name>${packageName})@(?<version>${version})$`,
);
const aliasDescriptor = new RegExp(
	`^(?:${packageName})@npm:(?<name>${packageName})@(?<version>${version})$`,
);

export function parseAddedPackageVersions(diff: string): PackageVersion[] {
	const packages = new Map<string, PackageVersion>();

	for (const line of diff.split("\n")) {
		const match = /^\+\s*"[^"]+":\s*\["([^"]+)"/.exec(line);
		if (!match) {
			continue;
		}

		const descriptor = match[1];
		if (descriptor.includes("@workspace:")) {
			continue;
		}

		const parsed =
			aliasDescriptor.exec(descriptor) ?? directDescriptor.exec(descriptor);
		const name = parsed?.groups?.name;
		const version = parsed?.groups?.version;
		if (!name || !version) {
			throw new Error(
				`Unsupported non-registry lockfile descriptor: ${descriptor}`,
			);
		}

		packages.set(`${name}@${version}`, { name, version });
	}

	return [...packages.values()].sort((left, right) =>
		`${left.name}@${left.version}`.localeCompare(
			`${right.name}@${right.version}`,
		),
	);
}

export async function assertReleaseAges(
	packages: PackageVersion[],
	minimumAgeDays: number,
	now: Date,
	publishedAt: (pkg: PackageVersion) => Promise<Date>,
): Promise<void> {
	const minimumAgeMs = minimumAgeDays * MILLIS_PER_DAY;
	const violations: string[] = [];

	for (const pkg of packages) {
		const exceptionEndsAt =
			TEMPORARY_SECURITY_RELEASE_AGE_EXCEPTIONS.get(`${pkg.name}@${pkg.version}`);
		if (exceptionEndsAt && now.getTime() < exceptionEndsAt.getTime()) {
			continue;
		}

		const published = await publishedAt(pkg);
		if (Number.isNaN(published.getTime())) {
			throw new Error(
				`npm did not provide a publish timestamp for ${pkg.name}@${pkg.version}`,
			);
		}

		if (now.getTime() - published.getTime() < minimumAgeMs) {
			violations.push(`${pkg.name}@${pkg.version}`);
		}
	}

	if (violations.length > 0) {
		throw new Error(
			`${violations.join(", ")} ${violations.length === 1 ? "was" : "were"} published less than the required ${minimumAgeDays} days ago`,
		);
	}
}

async function fetchPublishTime(pkg: PackageVersion): Promise<Date> {
	const response = await fetch(
		`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`,
	);
	if (!response.ok) {
		throw new Error(
			`npm registry lookup failed for ${pkg.name}@${pkg.version}: HTTP ${response.status}`,
		);
	}

	const metadata = (await response.json()) as {
		time?: Record<string, string | undefined>;
	};
	const timestamp = metadata.time?.[pkg.version];
	if (!timestamp) {
		throw new Error(
			`npm did not provide a publish timestamp for ${pkg.name}@${pkg.version}`,
		);
	}

	return new Date(timestamp);
}

function gitDiff(baseSha: string, targetSha: string): string {
	const mergeBase = Bun.spawnSync(["git", "merge-base", baseSha, targetSha]);
	if (mergeBase.exitCode !== 0) {
		throw new Error(`BASE_SHA ${baseSha} has no merge base with ${targetSha}`);
	}

	const commonBase = new TextDecoder().decode(mergeBase.stdout).trim();
	if (!commonBase) {
		throw new Error(`BASE_SHA ${baseSha} has no merge base with ${targetSha}`);
	}

	const result = Bun.spawnSync([
		"git",
		"diff",
		"--unified=0",
		commonBase,
		targetSha,
		"--",
		"bun.lock",
	]);
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr));
	}

	return new TextDecoder().decode(result.stdout);
}

async function main(): Promise<void> {
	const baseSha = process.argv[2];
	const targetSha = process.argv[3] ?? "HEAD";
	if (!baseSha) {
		throw new Error(
			"Usage: bun run infra/scripts/verify-dependency-release-age.ts <base-sha> [target-sha]",
		);
	}

	const packages = parseAddedPackageVersions(gitDiff(baseSha, targetSha));
	await assertReleaseAges(
		packages,
		MINIMUM_RELEASE_AGE_DAYS,
		new Date(),
		fetchPublishTime,
	);
	console.log(
		`Verified ${packages.length} newly locked npm package version(s) meet the ${MINIMUM_RELEASE_AGE_DAYS}-day release-age policy.`,
	);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
