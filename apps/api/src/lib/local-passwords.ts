export const LOCAL_PASSWORD_POLICY = Object.freeze({
	version: 1,
	algorithm: "argon2id" as const,
	memoryCost: 65536,
	timeCost: 3,
});
const supportedPasswordPolicyVersions = new Set([1]);

export type PasswordHash = {
	password_hash: string;
	password_algorithm: string;
	password_version: number;
};

export function validLocalPassword(password: unknown): password is string {
	return (
		typeof password === "string" &&
		Buffer.byteLength(password) > 0 &&
		Buffer.byteLength(password) <= 1024
	);
}

export function validNewLocalPassword(password: unknown): password is string {
	return validLocalPassword(password) && Array.from(password).length >= 12;
}

export async function hashLocalPassword(
	password: string,
): Promise<PasswordHash> {
	if (!validLocalPassword(password)) throw new Error("Invalid local password");
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
		!validLocalPassword(password) ||
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
