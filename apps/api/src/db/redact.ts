// Optional input/output text redaction. When ASTRAEA_REDACT_INPUT=true,
// the normalized trace's input_text and output_text are replaced with
// "[REDACTED]" before insertion to ClickHouse. Useful when agents send
// PII or other sensitive data to the trace pipeline. The raw attributes
// column is also stripped of any keys in ASTRAEA_REDACT_KEYS (comma-sep).
//
// Defaults to off (no redaction) — dev-friendly. Production should set
// ASTRAEA_REDACT_INPUT=true.

const REDACTED = "[REDACTED]";

function shouldRedactInput(): boolean {
  return (process.env.ASTRAEA_REDACT_INPUT ?? "").toLowerCase() === "true";
}

function redactKeys(): string[] {
  const raw = process.env.ASTRAEA_REDACT_KEYS ?? "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
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

export function redactTraceText(text: string | null | undefined, opts: RedactionOptions): string {
  if (!opts.redactInput) return text ?? "";
  return text ? REDACTED : "";
}

export function redactAttributesJson(
  attrsJson: string,
  opts: RedactionOptions,
): string {
  if (opts.redactKeys.length === 0) return attrsJson;
  try {
    const arr = JSON.parse(attrsJson) as Array<{ key: string; value?: { stringValue?: string } }>;
    const filtered = arr.filter((a) => !opts.redactKeys.includes(a.key));
    // If the matching key had a value, replace with REDACTED (so downstream
    // consumers can still see the key existed, but not its value).
    const redacted = arr.map((a) => {
      if (!opts.redactKeys.includes(a.key)) return a;
      if (!a.value) return { key: a.key };
      return { key: a.key, value: { stringValue: REDACTED } };
    });
    // Replace removed entries with the redacted form (preserves key names).
    void filtered;
    return JSON.stringify(redacted);
  } catch {
    // Malformed JSON — leave as-is.
    return attrsJson;
  }
}