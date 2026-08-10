import { createHash } from "node:crypto";

export const BASIC_AUTH_PROVIDER_NAMESPACE = "basic:v1";
export const INTERNAL_EVALUATION_WORKER_PROVIDER_NAMESPACE =
	"internal:evaluation-worker:v1";

export function deterministicActorId(
	provider: string,
	subject: string,
): string {
	const hash = createHash("md5").update(`${provider}:${subject}`).digest("hex");
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function evaluationWorkerActorId(organizationId: string): string {
	return deterministicActorId(
		INTERNAL_EVALUATION_WORKER_PROVIDER_NAMESPACE,
		organizationId,
	);
}
