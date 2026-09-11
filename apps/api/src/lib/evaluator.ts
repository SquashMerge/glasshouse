export type EvaluationCase = {
	input: Record<string, unknown>;
	expected_output: Record<string, unknown> | null;
};

export type EvaluationEvaluatorContract = {
	kind: "exact_match" | "contains";
	version: "v1";
	expected_output_path?: string;
	output_path?: string;
};

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

function atPath(value: unknown, path: string): unknown {
	if (!/^\$\.[A-Za-z0-9_.-]+$/.test(path)) return undefined;
	return path
		.slice(2)
		.split(".")
		.reduce<unknown>((current, key) => {
			if (!current || typeof current !== "object" || Array.isArray(current))
				return undefined;
			return (current as Record<string, unknown>)[key];
		}, value);
}

function compare(
	kind: "exact_match" | "contains",
	expected: unknown,
	actual: unknown,
): number {
	if (expected === undefined || actual === undefined) return 0;
	if (kind === "exact_match")
		return stable(expected) === stable(actual) ? 1 : 0;
	const wanted =
		typeof expected === "string" ? expected : JSON.stringify(expected);
	const received = typeof actual === "string" ? actual : JSON.stringify(actual);
	return wanted && received.toLowerCase().includes(wanted.toLowerCase())
		? 1
		: 0;
}

export function exactMatch(expected: unknown, actual: unknown): number {
	return compare("exact_match", expected, actual);
}
export function textContains(expected: unknown, actual: unknown): number {
	return compare("contains", expected, actual);
}
export function scoreCase(
	kind: "exact_match" | "contains",
	expected: unknown,
	actual: unknown,
): Record<string, number> {
	return { [kind]: compare(kind, expected, actual) };
}

export function explainCase(
	contract: EvaluationEvaluatorContract,
	expectedDocument: unknown,
	actualDocument: unknown,
): Record<string, unknown> {
	const expected = atPath(
		expectedDocument,
		contract.expected_output_path ?? "$.expected_output",
	);
	const actual = atPath(actualDocument, contract.output_path ?? "$.output");
	const score = compare(contract.kind, expected, actual);
	return {
		kind: contract.kind,
		version: contract.version,
		expected_output_path: contract.expected_output_path ?? "$.expected_output",
		output_path: contract.output_path ?? "$.output",
		score,
		match: score === 1,
		expected,
		actual,
	};
}
