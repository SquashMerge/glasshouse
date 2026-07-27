export type EvaluationCase = {
	input: Record<string, unknown>;
	expected_output: Record<string, unknown> | null;
};

function stable(value: unknown): string {
	return JSON.stringify(
		value,
		Object.keys(
			value && typeof value === "object" && !Array.isArray(value)
				? (value as Record<string, unknown>)
				: {},
		).sort(),
	);
}
export function exactMatch(expected: unknown, actual: unknown): number {
	return stable(expected) === stable(actual) ? 1 : 0;
}
export function textContains(expected: unknown, actual: unknown): number {
	const wanted =
		typeof expected === "string" ? expected : JSON.stringify(expected);
	const received = typeof actual === "string" ? actual : JSON.stringify(actual);
	return wanted && received.toLowerCase().includes(wanted.toLowerCase())
		? 1
		: 0;
}
export function scoreCase(
	kind: "exact_match" | "contains",
	expected: unknown,
	actual: unknown,
): Record<string, number> {
	return {
		[kind]:
			kind === "exact_match"
				? exactMatch(expected, actual)
				: textContains(expected, actual),
	};
}
