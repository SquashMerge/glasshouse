export type PackageVersion = {
	name: string;
	version: string;
};

const MINIMUM_RELEASE_AGE_DAYS = 7;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseAddedPackageVersions(diff: string): PackageVersion[] {
	const packages = new Map<string, PackageVersion>();

	for (const line of diff.split("\n")) {
		const match = /^\+\s*"[^"]+":\s*\["([^"]+)"/.exec(line);
		if (!match) {
			continue;
		}

		const descriptor = /^(?<name>@[^/]+\/[^@]+|[^@]+)@(?<version>.+)$/.exec(
			match[1],
		);
		const name = descriptor?.groups?.name;
		const version = descriptor?.groups?.version;
		if (!name || !version || !exactVersion.test(version)) {
			continue;
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
	const ancestor = Bun.spawnSync([
		"git",
		"merge-base",
		"--is-ancestor",
		baseSha,
		targetSha,
	]);
	if (ancestor.exitCode !== 0) {
		throw new Error(`BASE_SHA ${baseSha} is not an ancestor of ${targetSha}`);
	}

	const result = Bun.spawnSync([
		"git",
		"diff",
		"--unified=0",
		baseSha,
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
