const transientStorageCodes = new Set([
	"53300",
	"57P01",
	"57P03",
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ETIMEDOUT",
]);

export function isTransientStorageFailure(error: unknown): boolean {
	return (
		!!error &&
		typeof error === "object" &&
		"code" in error &&
		transientStorageCodes.has(String(error.code))
	);
}
