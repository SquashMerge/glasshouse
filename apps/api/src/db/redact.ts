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
	if (opts.redactKeys.length === 0) return attrsJson;
	try {
		const arr = JSON.parse(attrsJson) as Array<{
			key: string;
			value?: { stringValue?: string };
		}>;
		// Keep the key but replace the value so downstream consumers can still see the key existed.
		const redacted = arr.map((a) => {
			if (!opts.redactKeys.includes(a.key)) return a;
			if (!a.value) return { key: a.key };
			return { key: a.key, value: { stringValue: REDACTED } };
		});
		return JSON.stringify(redacted);
	} catch {
		return attrsJson;
	}
}
