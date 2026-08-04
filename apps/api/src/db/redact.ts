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
	return {
		redactInput: policy.mode === "all_text",
		redactKeys: policy.keys,
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
	return redactObservationMetadata(metadata, opts.redactKeys, REDACTED);
}
