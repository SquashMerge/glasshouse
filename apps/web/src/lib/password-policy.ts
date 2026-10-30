const minimumPasswordCharacters = 12;
const maximumPasswordBytes = 1024;

export function getNewPasswordValidationError(password: string): string | null {
	if (Array.from(password).length < minimumPasswordCharacters) {
		return "Use at least 12 characters. Longer, unique passphrases are easier to remember.";
	}
	if (new TextEncoder().encode(password).length > maximumPasswordBytes) {
		return "Password is too long. Try a shorter one.";
	}
	return null;
}
