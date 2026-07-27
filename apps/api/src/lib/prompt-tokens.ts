const TOKEN = /{{{?\s*([#^/!>&]?\s*[A-Za-z0-9_.-]+)\s*}?}}/g;
const DELIMITER_SWITCH = /{{\s*=[\s\S]*?=\s*}}/;

export function mustacheTokenSignature(source: string): string[] {
	return [...source.matchAll(TOKEN)].map((match) =>
		match[1]!.replace(/\s+/g, ""),
	);
}

export function hasMatchingMustacheTokenSignature(
	source: string,
	candidate: string,
): boolean {
	// Candidate delimiter switches could hide runtime variables from TOKEN.
	if (DELIMITER_SWITCH.test(source) || DELIMITER_SWITCH.test(candidate))
		return false;
	const expected = mustacheTokenSignature(source);
	const actual = mustacheTokenSignature(candidate);
	return (
		expected.length === actual.length &&
		expected.every((token, index) => token === actual[index])
	);
}
