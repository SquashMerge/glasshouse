export type PackageVersion = {
	name: string;
	version: string;
};

const MINIMUM_RELEASE_AGE_DAYS = 7;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

// CVE-2026-69152 is a high-severity denial-of-service vulnerability in the
// transitive migration dependency. The exception ends at the exact point where
// the normal seven-day policy accepts the upstream 5.0.9 security patch.
// CVE-2026-67213 is a high-severity vulnerability in PostCSS's transitive
// nanoid dependency. This exact-version exception expires with the normal
// seven-day policy window.
const TEMPORARY_SECURITY_RELEASE_AGE_EXCEPTIONS = new Map([
	["brace-expansion@5.0.9", new Date("2026-08-06T10:00:32.762Z")],
	["nanoid@3.3.18", new Date("2026-08-14T16:41:05.696Z")],
]);
const packageName = String.raw`(?:@[A-Za-z0-9._~-]+/)?[A-Za-z0-9._~-]+`;
const version = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const directDescriptor = new RegExp(
	`^(?<name>${packageName})@(?<version>${version})$`,
);
const aliasDescriptor = new RegExp(
	`^(?:${packageName})@npm:(?<name>${packageName})@(?<version>${version})$`,
);
const workspaceDescriptor = new RegExp(
	`^(?<name>${packageName})@workspace:(?<path>.+)$`,
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePackageVersions(lockfile: string): Map<string, PackageVersion> {
	let parsed: unknown;
	try {
		parsed = Bun.JSONC.parse(lockfile);
	} catch {
		throw new Error("Invalid Bun JSONC lockfile");
	}
	if (
		!isRecord(parsed) ||
		parsed.lockfileVersion !== 1 ||
		(parsed.configVersion !== undefined && parsed.configVersion !== 1) ||
		!isRecord(parsed.workspaces) ||
		!isRecord(parsed.packages)
	)
		throw new Error("Unsupported Bun lockfile structure or version");
	const workspaces = parsed.workspaces;
	const packages = new Map<string, PackageVersion>();

	for (const record of Object.values(parsed.packages)) {
		if (!Array.isArray(record) || typeof record[0] !== "string")
			throw new Error("Unsupported Bun package record");
		const descriptor = record[0];
		const workspace = workspaceDescriptor.exec(descriptor);
		if (workspace?.groups) {
			const definition = Object.hasOwn(workspaces, workspace.groups.path)
				? workspaces[workspace.groups.path]
				: undefined;
			if (
				record.length !== 1 ||
				!isRecord(definition) ||
				definition.name !== workspace.groups.name
			)
				throw new Error("Unsupported Bun workspace record");
			continue;
		}

		const identity =
			aliasDescriptor.exec(descriptor) ?? directDescriptor.exec(descriptor);
		const name = identity?.groups?.name;
		const version = identity?.groups?.version;
		if (!name || !version)
			throw new Error("Unsupported non-registry lockfile descriptor");
		// Only the repository's default npm-registry tuple is supported. A custom
		// source must not borrow npm release metadata to pass this check.
		if (
			record.length !== 4 ||
			record[1] !== "" ||
			!isRecord(record[2]) ||
			typeof record[3] !== "string" ||
			!/^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/.test(record[3])
		)
			throw new Error("Unsupported Bun registry package record");

		packages.set(`${name}@${version}`, { name, version });
	}

	return packages;
}

export function newlyLockedPackageVersions(
	baseLockfile: string,
	targetLockfile: string,
): PackageVersion[] {
	const base = parsePackageVersions(baseLockfile);
	const target = parsePackageVersions(targetLockfile);
	return [...target.entries()]
		.filter(([identity]) => !base.has(identity))
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, pkg]) => pkg);
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

function gitOutput(args: string[]): string {
	const result = Bun.spawnSync(["git", ...args]);
	if (result.exitCode !== 0)
		throw new Error("Cannot read the requested Git revisions and Bun lockfiles");
	return new TextDecoder().decode(result.stdout);
}

function gitLockfiles(baseRef: string, targetRef: string) {
	const resolve = (ref: string) =>
		gitOutput([
			"rev-parse",
			"--verify",
			"--end-of-options",
			`${ref}^{commit}`,
		]).trim();
	const baseSha = resolve(baseRef);
	const targetSha = resolve(targetRef);
	const commonBase = gitOutput(["merge-base", baseSha, targetSha]).trim();
	if (!commonBase) throw new Error("Git revisions have no common merge base");
	// Read untrusted PR data as blobs; never check it out, import it, or install it.
	return {
		base: gitOutput(["show", `${commonBase}:bun.lock`]),
		target: gitOutput(["show", `${targetSha}:bun.lock`]),
	};
}

async function main(): Promise<void> {
	const baseSha = process.argv[2];
	const targetSha = process.argv[3] ?? "HEAD";
	if (!baseSha) {
		throw new Error(
			"Usage: bun run infra/scripts/verify-dependency-release-age.ts <base-sha> [target-sha]",
		);
	}

	const lockfiles = gitLockfiles(baseSha, targetSha);
	const packages = newlyLockedPackageVersions(lockfiles.base, lockfiles.target);
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
