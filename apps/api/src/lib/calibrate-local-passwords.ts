import { randomBytes } from "node:crypto";
import {
	hashLocalPassword,
	LOCAL_PASSWORD_POLICY,
	verifyLocalPassword,
} from "./local-passwords.js";

const samples: { hash_ms: number; verify_ms: number }[] = [];
for (let iteration = 0; iteration < 20; iteration++) {
	const password = randomBytes(32).toString("base64url");
	const start = performance.now();
	const hash = await hashLocalPassword(password);
	const hashed = performance.now();
	const result = await verifyLocalPassword(password, hash);
	if (!result.verified)
		throw new Error("Password calibration verification failed");
	samples.push({
		hash_ms: hashed - start,
		verify_ms: performance.now() - hashed,
	});
}
const percentile = (key: "hash_ms" | "verify_ms", fraction: number) =>
	Math.round(
		samples.map((sample) => sample[key]).sort((a, b) => a - b)[
			Math.ceil(samples.length * fraction) - 1
		]!,
	);
process.stdout.write(
	`${JSON.stringify({ bun: Bun.version, policy: LOCAL_PASSWORD_POLICY, samples: samples.length, hash_p50_ms: percentile("hash_ms", 0.5), hash_p95_ms: percentile("hash_ms", 0.95), verify_p50_ms: percentile("verify_ms", 0.5), verify_p95_ms: percentile("verify_ms", 0.95) })}\n`,
);
