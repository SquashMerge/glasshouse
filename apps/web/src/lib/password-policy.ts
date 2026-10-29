export const PASSWORD_REQUIREMENTS =
	"Password must contain at least 12 Unicode characters and at most 1024 UTF-8 bytes.";

export function validNewPassword(value: string): boolean {
	return (
		Array.from(value).length >= 12 &&
		new TextEncoder().encode(value).byteLength <= 1024
	);
}
