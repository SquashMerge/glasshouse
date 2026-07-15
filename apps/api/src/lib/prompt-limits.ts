export const MAX_PROMPT_SOURCE_CHARS = 32_768;
export const MAX_PROMPT_SOURCE_LINES = 512;
export const MAX_TEMPLATE_SECTION_NESTING = 8;
export const MAX_RENDER_DATA_DEPTH = 8;
export const MAX_RENDER_DATA_NODES = 1_024;
export const MAX_RENDER_ARRAY_LENGTH = 128;
export const MAX_RENDER_DATA_STRING_BYTES = 32_768;
export const MAX_DIFF_INPUT_CHARS = 32_768;
export const MAX_DIFF_INPUT_LINES = 512;

export function hasAtMostLines(value: string, maxLines: number): boolean {
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n" && ++lines > maxLines) return false;
  }
  return true;
}

export function promptSourceBudgetError(value: string): string | null {
  if (value.length > MAX_PROMPT_SOURCE_CHARS) {
    return `Prompt source exceeds ${MAX_PROMPT_SOURCE_CHARS} characters`;
  }
  if (!hasAtMostLines(value, MAX_PROMPT_SOURCE_LINES)) {
    return `Prompt source exceeds ${MAX_PROMPT_SOURCE_LINES} lines`;
  }
  return null;
}
