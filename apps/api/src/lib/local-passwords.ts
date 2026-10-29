export const LOCAL_PASSWORD_POLICY = Object.freeze({
	version: 1,
	algorithm: "argon2id" as const,
	memoryCost: 65536,
	timeCost: 3,
});
const supportedPasswordPolicyVersions = new Set([1]);
export const LOCAL_PASSWORD_MIN_CHARACTERS = 12;
export const LOCAL_PASSWORD_MAX_BYTES = 1024;
export const LOCAL_PASSWORD_REQUIREMENTS =
	"Password must contain at least 12 Unicode characters and at most 1024 UTF-8 bytes";

export type PasswordHash = {
	password_hash: string;
	password_algorithm: string;
	password_version: number;
};

export function validLocalPassword(password: unknown): password is string {
	return (
		validLocalPasswordInput(password) &&
		Array.from(password).length >= LOCAL_PASSWORD_MIN_CHARACTERS
	);
}

export function validLocalPasswordInput(password: unknown): password is string {
	return (
		typeof password === "string" &&
		Buffer.byteLength(password) > 0 &&
		Buffer.byteLength(password) <= LOCAL_PASSWORD_MAX_BYTES
	);
}

export async function hashLocalPassword(
	password: string,
): Promise<PasswordHash> {
	if (!validLocalPassword(password))
		throw new Error(LOCAL_PASSWORD_REQUIREMENTS);
	return {
		password_hash: await Bun.password.hash(password, LOCAL_PASSWORD_POLICY),
		password_algorithm: LOCAL_PASSWORD_POLICY.algorithm,
		password_version: LOCAL_PASSWORD_POLICY.version,
	};
}

export async function verifyLocalPassword(
	password: string,
	stored: PasswordHash,
): Promise<{ verified: boolean; rehash: boolean }> {
	if (
		!validLocalPasswordInput(password) ||
		stored.password_algorithm !== "argon2id" ||
		!supportedPasswordPolicyVersions.has(stored.password_version)
	)
		return { verified: false, rehash: false };
	const parameters = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(
		stored.password_hash,
	);
	if (!parameters) return { verified: false, rehash: false };
	const [, memory, time, parallelism] = parameters;
	// Bound work even if a corrupted/imported PHC string reaches this boundary.
	if (
		Number(memory) < 8 ||
		Number(memory) > 262144 ||
		Number(time) < 1 ||
		Number(time) > 10 ||
		Number(parallelism) < 1 ||
		Number(parallelism) > 4
	)
		return { verified: false, rehash: false };
	try {
		const verified = await Bun.password.verify(
			password,
			stored.password_hash,
			"argon2id",
		);
		return {
			verified,
			rehash:
				verified &&
				validLocalPassword(password) &&
				Number(memory) <= LOCAL_PASSWORD_POLICY.memoryCost &&
				Number(time) <= LOCAL_PASSWORD_POLICY.timeCost &&
				(stored.password_version !== LOCAL_PASSWORD_POLICY.version ||
					Number(memory) < LOCAL_PASSWORD_POLICY.memoryCost ||
					Number(time) < LOCAL_PASSWORD_POLICY.timeCost),
		};
	} catch {
		return { verified: false, rehash: false };
	}
}
