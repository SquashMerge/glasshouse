export interface ClipboardWriter {
  writeText: (text: string) => Promise<void>;
}

export type ClipboardResult = { ok: true } | { ok: false; error: "unavailable" | "failed" };

function browserClipboard(): ClipboardWriter | null {
  if (typeof navigator === "undefined" || !navigator.clipboard) return null;
  return navigator.clipboard;
}

export async function copyText(text: string, writer: ClipboardWriter | null = browserClipboard()): Promise<ClipboardResult> {
  if (!writer) return { ok: false, error: "unavailable" };
  try {
    await writer.writeText(text);
    return { ok: true };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export async function copyJson(value: unknown, writer?: ClipboardWriter | null): Promise<ClipboardResult> {
  try {
    return await copyText(JSON.stringify(value, null, 2), writer);
  } catch {
    return { ok: false, error: "failed" };
  }
}
