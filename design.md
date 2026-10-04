# Astraea UI design guide

This guide describes the visual and interaction conventions for the Astraea web app. It is grounded in the current implementation, not a redesign proposal. Keep it aligned with the durable agent rules in [`AGENTS.md`](AGENTS.md) and the actual tokens and shared components cited below.

## Design intent

Astraea is a data-rich workspace for inspecting and managing AI evaluations, datasets, feedback, prompts, and traces. The UI should feel calm, precise, and operational: clear hierarchy, compact but readable information, neutral surfaces, and obvious actions. Prefer consistency with the existing application over introducing a page-specific visual language.

## Color and theme

Use semantic Tailwind classes backed by the CSS custom properties in `apps/web/src/styles/globals.css`. The app supports light mode at `:root` and dark mode through `.dark`; keep both themes legible when adding a semantic color.

| Role | Light HSL values | Dark HSL values |
| --- | --- | --- |
| Background / card | `0 0% 100%` | `222 47% 6%` |
| Foreground / card text | `222 47% 11%` | `210 40% 98%` |
| Popover | `0 0% 100%` | `222 47% 9%` |
| Border / input | `214 32% 91%` | `217 33% 17%` |
| Primary | `222 47% 11%` | `210 40% 98%` |
| Primary foreground | `210 40% 98%` | `222 47% 11%` |
| Secondary / muted / accent | `210 40% 96%` | `217 33% 17%` |
| Secondary / accent foreground | `222 47% 11%` | `210 40% 98%` |
| Muted foreground | `215 16% 47%` | `215 20% 65%` |
| Destructive | `0 84% 60%` | `0 63% 50%` |
| Destructive foreground | `210 40% 98%` | `210 40% 98%` |
| Focus ring | `222 47% 11%` | `215 20% 65%` |

Use classes such as `bg-background`, `text-foreground`, `bg-card`, `text-muted-foreground`, `border-border`, `bg-primary`, and `text-destructive`. Avoid hard-coded page-level colors; if a semantic role is genuinely missing, add it to both light and dark CSS variables and map it in `apps/web/tailwind.config.ts` rather than creating one-off styles.

**Token gap to keep in mind:** `tailwind.config.ts` maps `success` to `--success`, but `globals.css` currently does not declare `--success`. Do not treat that as a complete, theme-safe token for new UI until both theme values exist; status should also be conveyed with text or an icon, not color alone.

## Typography and shape

- The global font stack is the system sans-serif stack defined on `body` in `globals.css`; do not add a second product font for an individual page.
- Use a small, consistent hierarchy: one clear page `h1`, section/card headings, normal body copy, then muted supporting text and compact metadata. Shared card headings and descriptions use `text-2xl font-semibold tracking-tight` and `text-sm text-muted-foreground` respectively.
- The shared radius token is `--radius: 0.5rem`; Tailwind `rounded-lg`, `rounded-md`, and `rounded-sm` are derived from it. Prefer shared radii over arbitrary values.
- Use `cn` from `apps/web/src/lib/utils.ts` when composing conditional classes.

## Application layout

Authenticated pages live inside `AppShell`. Its content area intentionally uses the full workspace width (`APP_WORKSPACE_CLASS = "max-w-none"`), with `px-4 py-5` and `sm:px-6 sm:py-8`. Do not add arbitrary outer max-widths to product pages; use a local width constraint only when the content itself calls for it, such as a compact form, dialog, or popover.

The navigation is collapsible and responsive, with a compact project selector at small widths. Keep the main content `min-w-0`, allow toolbars and action groups to wrap or stack, and prevent tables, cards, and long identifiers from forcing horizontal page overflow. Keep project context and the shared shell visible in the normal authenticated workflow.

## Page composition and spacing

- Give the page title, description, primary action, filters, and main content clear visual separation. Prefer a simple heading/action row followed by sections or cards.
- Reuse `Card`, `CardHeader`, `CardTitle`, `CardDescription`, and `CardContent` for grouped content. The card primitives already supply border, radius, background, padding, and typography; avoid rebuilding those styles per page.
- Maintain a deliberate spacing rhythm. Existing form patterns use `space-y-2` between a label and its field, `space-y-4` for related setup/status content, and `space-y-5` between form rows. Use clear gaps between adjacent cards and sections; do not let borders visually fuse.
- Keep primary actions easy to find and use the shared button variants. Use destructive styling for consequential destructive actions, not as a decorative accent.

## Shared components and controls

Prefer the existing shadcn-style primitives in `apps/web/src/components/ui/` over raw replicas: `Button`, `Input`, `Label`, `Card`, `Alert`, `Badge`, `Select`, `Separator`, `Skeleton`, and the dropdown/menu components. Extend or add a shared primitive when a reusable pattern is missing instead of copying a slightly different version into each route.

Use the provided control sizes and interaction states: buttons are compact, inputs are full-width by default, focus-visible rings are explicit, and disabled controls are visibly disabled. Link each visible form label to its control; pair hints and validation messages through accessible descriptions. For forms, show actionable errors close to the relevant content and preserve values only when it is safe and useful to do so.

## Data-dense screens and feedback states

Use shared table and filter patterns such as `FilterableTable` where their behavior fits. Keep column headings, row actions, filters, and counts scannable; use compact muted text for secondary metadata without shrinking primary values into unreadable text. Preserve the established data hierarchy rather than adding extra chrome around every value.

Design each data view for loading, empty, no-match, error, retry, and populated states. Reuse `Skeleton` for loading, `Alert` or `role="alert"` for errors, and a clear retry action when recovery is possible. Empty states should tell the user what is absent and, where appropriate, what action to take. For live updates, use the shared accent/highlight treatment briefly and do not make animation the only indication of change.

## Accessibility and interaction

- Use semantic landmarks and heading order; provide an accessible name for icon-only controls.
- Preserve keyboard access, visible focus, logical focus order, and sufficient touch targets at narrow widths.
- Use native labels, buttons, links, and form controls when possible. Do not use placeholder text as a substitute for a label.
- Associate helper/error text with its field. Announce dynamic errors/statuses with the appropriate live-region semantics and move focus only when the workflow requires it.
- Do not communicate status, selection, or severity through color alone. Respect reduced-motion preferences and avoid unnecessary motion.
- Treat WCAG contrast as a design target when adding or changing color pairs; this guide is not a claim that every existing surface has been audited.

## Do and avoid

**Do**
- Use semantic theme classes and shared primitives.
- Match established spacing, typography, control sizes, and focus states.
- Keep authenticated product pages aligned to `AppShell` and the project workspace.
- Check the same page at desktop, tablet, and mobile widths, including loading and error states.

**Avoid**
- Page-local palettes, ad hoc shadows/radii, and custom CSS when shared tokens and utilities suffice.
- Arbitrary width caps around full workspace pages.
- Fused card layouts, cramped label/control spacing, and unwrapped action rows on mobile.
- One-off control implementations that diverge from the shared primitives.
- New status colors or success styles that are not defined for both themes.

## Implementation references

- Global tokens, dark theme, and font stack: `apps/web/src/styles/globals.css`
- Tailwind semantic color/radius mappings: `apps/web/tailwind.config.ts`
- Workspace contract and responsive navigation: `apps/web/src/components/AppShell.tsx`
- Shared buttons, inputs, labels, cards, alerts, and badges: `apps/web/src/components/ui/`
- Shared table and filter pattern: `apps/web/src/components/FilterableTable.tsx`
- Representative compact form composition: `apps/web/src/routes/password-change.tsx`
- Repository-level UI quality bar: `AGENTS.md` (UI design and quality section)
