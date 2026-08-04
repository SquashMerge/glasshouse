import {
	redactObservationMetadata,
	redactSerializedObservationMetadata,
	type ObservationMetadata,
} from "./observation-metadata.js";

const REDACTED = "[REDACTED]";

function shouldRedactInput(): boolean {
	return (process.env.ASTRAEA_REDACT_INPUT ?? "").toLowerCase() === "true";
}

function redactKeys(): string[] {
	const raw = process.env.ASTRAEA_REDACT_KEYS ?? "";
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export interface RedactionOptions {
	redactInput: boolean;
	redactKeys: string[];
}

export function policyRedactionOptions(policy: {
	mode: "none" | "all_text";
	keys: string[];
}): RedactionOptions {
	const baseline = loadRedactionOptions();
	return {
		// Deployment controls are an operator-enforced floor, never a policy override.
		redactInput: baseline.redactInput || policy.mode === "all_text",
		redactKeys: [...new Set([...baseline.redactKeys, ...policy.keys])],
	};
}

export function loadRedactionOptions(): RedactionOptions {
	return {
		redactInput: shouldRedactInput(),
		redactKeys: redactKeys(),
	};
}

export function redactTraceText(
	text: string | null | undefined,
	opts: RedactionOptions,
): string {
	if (!opts.redactInput) return text ?? "";
	return text ? REDACTED : "";
}

export function redactAttributesJson(
	attrsJson: string,
	opts: RedactionOptions,
): string {
	return redactSerializedObservationMetadata(
		attrsJson,
		opts.redactKeys,
		REDACTED,
	);
}

export function redactMetadata(
	metadata: ObservationMetadata,
	opts: RedactionOptions,
): ObservationMetadata {
	const redacted = redactObservationMetadata(
		metadata,
		opts.redactKeys,
		REDACTED,
	);
	return opts.redactInput
		? {
				...redacted,
				attributes: redacted.attributes.filter(
					(attribute) => !isNormalizedTextAttribute(attribute.key),
				),
			}
		: redacted;
}

function isNormalizedTextAttribute(key: string): boolean {
	return (
		/^gen_ai\.(?:prompt|completion)\.\d+\.content$/.test(key) ||
		[
			"gen_ai.prompt",
			"gen_ai.completion",
			"gen_ai.input",
			"gen_ai.output",
			"input.value",
			"output.value",
			"openinference.input.value",
			"openinference.output.value",
			"llm.prompts",
			"llm.completions",
		].includes(key)
	);
}
