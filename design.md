---
title: Glasshouse design system
version: 1.1.0
product: Glasshouse by SquashMerge
status: implementation baseline
---

# Glasshouse design system

This is the product-specific adaptation of SquashMerge's shared design language for the Glasshouse web application. It defines the current visual baseline; it does not imply unshipped features, integrations, pricing, availability, or performance claims. Keep this file aligned with the actual UI and the central token definitions in `apps/web/src/styles/globals.css`.

## Product identity

- **SquashMerge** is the parent company and shared design language.
- **Glasshouse** is SquashMerge's observability and evaluation product for agentic applications.
- First reference in external-facing copy: **Glasshouse by SquashMerge**. Thereafter use **Glasshouse**.
- The software and Licensed Work were formerly called Astraea. Preserve that historical mapping only where it is needed for repository/license context; use Glasshouse for current UI, APIs, configuration, and product documentation.
- Do not invent launch dates, pricing, integration availability, or performance claims.

## Principles

1. Make system state, evidence, source references, and relationships visible.
2. Use hierarchy, alignment, and spacing to make technical structure understandable.
3. Make the next action clear and its result observable.
4. Keep neutral surfaces dominant; accents convey action, selection, focus, or status.
5. Be warm and precise, using restrained botanical cues and geometric paths only where they aid the product.

Avoid glossy 3D, neon glow, heavy shadows, decorative animated backgrounds, arbitrary product colors, and unrelated icon styles. The garden metaphor belongs in brand identity, not technical instructions.

## Logo and assets

The supplied Glasshouse artwork is stored at `apps/web/public/brand/glasshouse-logo-dark-v1.png` (1254 × 1254 RGB PNG with a dark background). Use the checked-in image unchanged: preserve aspect ratio, colors, artwork, and background. Do not crop, distort, recolor, filter, erase the background, trace, or recreate the wordmark. Its native artwork has two interior nodes, one amber and one purple.

The current sidebar uses the complete square artwork at 112 × 112 px on the expanded desktop navigation, leaving enough room for its wordmark to remain part of the artwork. On narrow or collapsed navigation, the application uses a text-only `Glasshouse` label rather than squeezing the presentation image into a nav icon. This is a responsive use of the supplied artwork, not a separately approved horizontal or compact mark. If a compact nav mark or horizontal lockup is needed, request a dedicated approved export rather than editing this image. The home link retains its accessible name in every layout. When adjacent text already names the product, treat the image as decorative; otherwise give it meaningful alt text. A linked logo must have an accessible link name.

The image is dark-background artwork; do not use it on an incompatible light surface. No favicon, transparent, editable SVG, or alternate responsive lockup is included in the supplied kit.

## Color system

The dark palette below is the current baseline. Values are centralized in `apps/web/src/styles/globals.css` as `--gh-*` HSL channels; Tailwind semantic colors reference those aliases. Change the palette there rather than scattering hex/RGB values through components. `design.md` records the corresponding design values; update it with intentional palette changes.

| Token | Hex | Use |
| --- | --- | --- |
| Ink | `#0B0C10` | Page background and text on bright actions |
| Surface | `#14151D` | Cards and popovers |
| Raised | `#1D1E2A` | Quiet navigation and raised groups |
| Line | `#343644` | Decorative dividers |
| Control | `#777A8E` | Meaningful input/control boundaries |
| White | `#F7F7FB` | Primary text |
| Muted | `#B8BAC8` | Secondary text |
| Gold | `#FFC20A` | Warm highlight |
| Amber | `#FFAA10` | Primary action and brand accent |
| Orange | `#FF7A00` | Warm gradient endpoint |
| Lavender | `#ABA5FF` | Links and focus on dark surfaces |
| Purple | `#7770DC` | Selection and structural accent |
| Deep purple | `#5D55C8` | Cool gradient endpoint |
| Green | `#57D6A0` | Success, always paired with a label/icon |
| Red | `#FF8E9A` | Error, always paired with a label/icon |
| Blue | `#85C7FF` | Information |

Use ink text on amber and purple fills; white on the specified amber or purple does not meet normal-text contrast. Links use lavender and remain underlined. Brand colors are not a universal success/failure mapping. Warm gradients run from gold to orange, cool gradients from lavender to deep purple; do not blend the warm and cool families or put gradients behind body copy. Large brand artwork only; no gradients are currently needed for ordinary application surfaces.

Light mode is not defined by this baseline. Do not invert dark values mechanically; introduce separately reviewed semantic aliases and contrast evidence before adding a light theme.

## Typography

| Role | Family | Weight |
| --- | --- | --- |
| Display and headings | Manrope | 600–800; display default 750 |
| Body and interface | Inter | 400 body, 600 labels, 650 emphasis |
| Code, IDs, and metrics | JetBrains Mono | 400 |

The font files are not bundled. Until approved files are available, use the existing system UI stack and monospace fallback; do not fetch unrelated fonts or retype the supplied wordmark. Use `font-display: swap` when adding licensed font files. Use sentence case, semantic headings, comfortable line height, restrained emphasis, and tabular numerals for aligned numeric values.

| Role | Size / line height |
| --- | --- |
| Display | 48 / 56 px |
| H1 | 32 / 40 px |
| H2 | 24 / 32 px |
| H3 | 18 / 26 px |
| Body | 16 / 24 px |
| Label | 14 / 20 px |
| Caption | 12 / 18 px |
| Code | 13 / 20 px |

## Layout and components

- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64 px.
- Component internals: 8–16 px; between groups: 24–32 px; between sections: 48–64 px.
- Radius: 4 px details, 8 px controls, 12 px cards. Reserve fully rounded shapes for chips, avatar crops, and status dots.
- Typical content width: 1120–1280 px where useful; data-heavy views may be wider when the content needs it.
- Mobile inset: 16–24 px. At 320 CSS px avoid whole-page horizontal scrolling; allow deliberate local overflow for code and wide tables with accessible access to the full content.
- Dividers: 1 px; ordinary UI icon stroke: 2 px. Do not apply logo strokes to interface icons.
- Align related components, padding, control heights, and labels consistently.

### Buttons and forms

Primary buttons use amber fill, ink text, an 8 px radius, a 14/20 px label, and a 44 px minimum height where layout permits. Secondary actions use neutral surfaces and visible boundaries. Destructive actions use explicit wording and semantic error styling; preserve established confirmation behavior. Use buttons for actions and links for navigation, with labels such as `Run evaluation`, `Open source`, or `Review changes`. Keep dimensions stable while loading and prevent duplicate submissions where appropriate.

Forms use persistent visible labels; placeholders are examples, not labels. Explain errors beside the affected field. Maintain visible keyboard focus, starting with a 2 px lavender ring and 3 px offset on dark surfaces. Reuse existing accessible dialogs, menus, selects, and validation components.

### Cards and technical data

Use cards to group related information, not to wrap every sentence. Use semantic tables for comparable records, label units, and align numeric values. Render paths and IDs in monospace; if shortened, provide an accessible way to reveal or copy the full value.

Required UI states:

- **Empty:** explain what belongs here and give the relevant next action.
- **Loading:** use a stable skeleton or meaningful progress; avoid layout jumps.
- **Error:** explain failure and recovery; do not imply success before a result.
- **Disabled:** communicate unavailability without relying on faint color alone.
- **Focus, hover, selected:** visibly distinct and keyboard-operable.

## Product visualization and status

- Make graph relationships functional, not decorative; use arrows when direction matters and avoid ambiguous crossings.
- Prefer short orthogonal connectors and keep source references beside the items they explain.
- Label observed, inferred, and planned relationships. Never fabricate source links, evaluations, trace IDs, or results.
- Use consistent units and scales. Mark illustrative or synthetic data clearly.
- Status uses words plus a shape, icon, or line style; never color alone.
- Glasshouse emphasizes observability and evaluations; these content differences do not create a separate product color scheme.

## Motion

Use 120 ms hover, 180 ms local-state changes, and 240 ms panel transitions with `cubic-bezier(0.2, 0, 0, 1)`. Prefer opacity and small movement. Do not continuously animate logos. Respect `prefers-reduced-motion`; remove decorative movement and use immediate state changes when practical.

## Voice

Be precise, calm, capable, and warm. Name the action, object, and evidence. Explain limitations plainly.

Working company description: `SquashMerge builds tools for understanding, evaluating and developing agentic applications.`

Prefer `Inspect the trace and compare evaluation results.` Avoid `Unlock revolutionary AI insights.` Keep technical terms concrete: evaluations, source-linked diagrams, memory, and pull requests. Do not introduce unsupported superlatives, pricing, availability, or integration promises.

## Accessibility and verification

- Target 4.5:1 contrast for normal text and 3:1 for large text under the applicable definition. Meaningful UI graphics and control boundaries need 3:1 where applicable.
- Contrast of a token pair alone does not prove a full interface passes; check real surfaces, focus, gradients, and interaction states.
- Preserve keyboard access, correct roles, accessible names, and visible focus. Reuse the repository's accessible interaction patterns.
- Do not rely on color, hover alone, or animation to communicate required information.
- Check affected flows at narrow and wide widths with realistic long content and all important states. Visually inspect the rendered changes and run relevant lint, type-check, build, and tests.

Primary references: [WCAG text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [WCAG non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

## Coding-agent workflow

1. Identify the current Glasshouse UI scope, styling system, shared components, and existing product status.
2. Read this file and the central semantic tokens. Resolve actual asset paths before using logos.
3. Implement only the requested scope using shared components and token aliases; do not restyle unrelated pages.
4. Preserve product status and claims. Ask for product direction when an unconfirmed commercial decision is necessary.
5. Inspect the rendered result, responsive layout, contrast, focus, and important states. Run focused tests and relevant project checks.
6. Report what changed, how it was verified, and any material limitation. Do not claim a whole-product update when only one flow changed.
