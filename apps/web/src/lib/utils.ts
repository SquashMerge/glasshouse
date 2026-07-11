// Tiny utility for conditional className joining.
// Avoids pulling in clsx/tailwind-merge for a single-fn helper.
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}