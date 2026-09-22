# Attendance Platform — Master Visual Design System

**Status:** Phase 2 specification. Design-system definition only — no application source code changes in this phase.
**Owner document for:** all future UI/UX overhaul phases (Prompt 3 onward).
**Scope:** visual language, tokens, component specs, layout rules, states.
**Not in scope:** business logic, RBAC, workflows, API contracts, DB schema, Face-AI logic.
**Preservation rule:** the existing Attendance product is the source of truth. Future phases enhance the presentation layer without altering functionality.

---

## 0. Preface — Phase 1 UX Audit status

Phase 1 UX Audit **was not found**. `docs/ui-ux/` existed as an empty directory. In place of a full audit, this document is grounded in a **read-only reconnaissance** of the current application:

- **Framework:** Next.js 16 (App Router), React 19, Tailwind CSS v4 (`@import "tailwindcss"` + `@theme inline`), TypeScript.
- **Font:** `Geist` + `Geist Mono` via `next/font/google` (`--font-geist-sans`, `--font-geist-mono`).
- **Component system:** hand-built primitives in `apps/web/src/components/ui/` — `Button`, `Badge`, `Panel/EmptyState`, `Input`, `Select`, `Field`, `Skeleton`, `TableScroll`, `ErrorState`, `attendance-stat` (`ResultBadge`, `RateBar`, `RatePercent`, `StatCard`, `StatGrid`). No shadcn/ui installed.
- **Palette in use:** Tailwind `neutral` (base), `emerald` (present/positive), `red` (absent/danger), `amber` (needs review/warning), `blue` (info), `green` (positive).
- **Attendance state semantics already codified** in `attendance-stat.tsx` (`PRESENT`, `ABSENT`, `NEEDS_REVIEW`, `NOT_EVALUATED` — where `NOT_EVALUATED` is deliberately shown as "Needs review" to users; the engine distinction is preserved in audit trails).
- **Routes surveyed:** `/login`, `/portal/*` (student & faculty), `/dashboard/*` (institution admin + platform), `/dashboard/platform/*` (super admin), `/dashboard/attendance`, `/dashboard/institutions`, `/dashboard/faculty`, `/dashboard/audit-logs`, `/dashboard/api-keys`, `/dashboard/campuses`, `/dashboard/academic`, `/dashboard/face-enrollment`, `/portal/enroll-face`, `/offline`, `/unauthorized`.
- **Print rules** exist in `globals.css` — reports are printed via the browser's print engine from a real page; the design system must not break `@media print`.
- **Dark mode:** `globals.css` currently switches by `prefers-color-scheme`. This document specifies both modes so a future phase can wire them properly without inventing a second palette.

Future phases inherit these invariants; nothing here overrides them.

---

## 1. Design Philosophy

The Attendance platform is an **operational, high-stakes, multi-tenant SaaS** used daily by Platform Super Admins, Institution Admins, Faculty, and Students. Attendance records are legal and academic artifacts — the UI is a tool, not a showcase.

Guiding principles:

1. **Operational calm over marketing polish.** Every screen should feel like a well-lit control room, not a landing page.
2. **Content is the interface.** Numbers, names, dates, and states are the product. Chrome recedes.
3. **Truthful visualization.** Uncertainty (AI review states, missing data, offline caches) is visible, never dressed up as certainty.
4. **AI assists; faculty decides.** Visual weight always favors the human corrector. AI output is offered, not declared.
5. **Density with dignity.** Admin tables and rosters can be dense — never crowded. Spacing scale is systematic; density is dial-able per surface (dashboards ≠ marketing).
6. **Consistency across four roles.** Super Admin, Institution Admin, Faculty, and Student share one visual language; they differ in information architecture, not skin.
7. **Accessibility is baseline.** WCAG 2.2 AA is the floor. Color is never the only signal.
8. **Reversibility.** Destructive actions are guarded, undoable where possible, and never look like the primary path.
9. **Offline is a first-class visual state.** Not an error banner tacked on — a treated, recognizable mode.

---

## 2. Brand Personality

| Dimension | Primary | Secondary |
|---|---|---|
| Voice | Precise, plain, respectful | Institutional |
| Feel | Calm, focused, dependable | Modern SaaS |
| Aesthetic | Minimal, content-first, gridded | Restrained enterprise |
| Not | Playful, gamified, neon, glassmorphic, marketing-flashy | Corporate stock-photo dry |

Analogues (aesthetic references, not templates): Linear, Stripe Dashboard, Vercel, Notion admin, Segment, Intercom Inbox. **Not**: school-portal clip-art, casino/consumer app dashboards, hackathon "AI futuristic" chrome.

---

## 3. Visual Direction

**Chosen direction:** *Operational Minimalism* — quiet neutrals, a single restrained brand hue, semantic status colors that carry meaning, generous whitespace at the edges, systematic density inside data surfaces.

**Rationale:**

- Current app already leans neutral + Tailwind semantic families; keeping continuity avoids a rewrite.
- Attendance data is judged in glances (a roster, a percentage, a status). Chrome noise reduces glance-accuracy.
- Multi-role platform → one clean base + role-specific IA prevents four visual dialects.
- AI states demand visible uncertainty; a loud brand palette makes uncertainty hard to read.

**Adjacent moves consciously rejected:**

- Gradients / glassmorphism → false depth on operational data.
- OLED dark-only → excludes daylight classroom / device use.
- Bento asymmetry → poor fit for tabular, comparable data.
- Excessive rounded cards → visual busywork.

---

## 4. Color System

All colors are **semantic tokens**. Never reference raw hex in components — always the token.

### 4.1 Neutral scale (base)

Anchored to Tailwind `neutral-*` (currently in use) with a documented purpose per stop.

| Token | Light hex | Dark hex | Purpose |
|---|---|---|---|
| `--color-bg-canvas` | `#FAFAFA` (neutral-50) | `#0A0A0A` (neutral-950) | Outermost page background |
| `--color-bg-surface` | `#FFFFFF` | `#171717` (neutral-900) | Cards, panels, table body |
| `--color-bg-elevated` | `#FFFFFF` + shadow | `#1F1F1F` | Popovers, dropdowns, dialogs |
| `--color-bg-sunken` | `#F5F5F5` (neutral-100) | `#0A0A0A` | Inputs, code, subtle wells |
| `--color-border-subtle` | `#E5E5E5` (neutral-200) | `#262626` (neutral-800) | Dividers, card borders |
| `--color-border-strong` | `#D4D4D4` (neutral-300) | `#404040` (neutral-700) | Inputs, active outlines |
| `--color-text-primary` | `#171717` (neutral-900) | `#FAFAFA` | Headings, body |
| `--color-text-secondary` | `#525252` (neutral-600) | `#A3A3A3` (neutral-400) | Descriptions, labels |
| `--color-text-muted` | `#737373` (neutral-500) | `#737373` | Captions, hints |
| `--color-text-disabled` | `#A3A3A3` (neutral-400) | `#525252` | Disabled state text |

### 4.2 Brand

A single restrained hue — indigo/slate blue — used sparingly for the primary CTA, the focus ring, and one accent per surface. The current app's `neutral-900` primary button is retained as the default *action* color; brand blue is reserved for identity moments (logo, sidebar accent, primary filled buttons where an action is genuinely "brand").

| Token | Light | Dark | Purpose |
|---|---|---|---|
| `--color-brand` | `#1E293B` (slate-800) | `#E2E8F0` | Logo, identity |
| `--color-brand-accent` | `#4F46E5` (indigo-600) | `#818CF8` (indigo-400) | Focus ring, links, active nav |
| `--color-brand-accent-hover` | `#4338CA` | `#A5B4FC` | Hover on links / accent buttons |
| `--color-action-primary` | `#171717` | `#FAFAFA` | Default primary action fill (matches current) |
| `--color-action-primary-fg` | `#FFFFFF` | `#0A0A0A` | Text on primary action |

Rationale for a **muted brand**: attendance status colors (green/red/amber) must dominate the visual field. A loud brand hue would compete with the state semantics.

### 4.3 Semantic status

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--color-success` | `#059669` (emerald-600) | `#34D399` (emerald-400) | Present, positive, confirmed |
| `--color-success-bg` | `#ECFDF5` (emerald-50) | `#064E3B` (emerald-900) | Success tint background |
| `--color-warning` | `#D97706` (amber-600) | `#FBBF24` (amber-400) | Needs review, below threshold |
| `--color-warning-bg` | `#FFFBEB` (amber-50) | `#78350F` (amber-900) | Warning tint background |
| `--color-danger` | `#DC2626` (red-600) | `#F87171` (red-400) | Absent, destructive, failed |
| `--color-danger-bg` | `#FEF2F2` (red-50) | `#7F1D1D` (red-900) | Danger tint background |
| `--color-info` | `#2563EB` (blue-600) | `#60A5FA` (blue-400) | Informational, help |
| `--color-info-bg` | `#EFF6FF` (blue-50) | `#1E3A8A` (blue-900) | Info tint background |
| `--color-neutral-state` | `#525252` | `#A3A3A3` | Neutral, not-yet-evaluated |
| `--color-neutral-state-bg` | `#F5F5F5` | `#262626` | Neutral tint |

### 4.4 Attendance-specific semantics

Maps to the enum values already in `attendance-stat.tsx`. Every state carries **color + text + icon + shape**. Color alone is never sufficient.

| State | Token | Icon (Lucide) | Badge shape | User-facing label |
|---|---|---|---|---|
| `PRESENT` | `--color-success` / `-bg` | `check-circle` | Pill | "Present" |
| `ABSENT` | `--color-danger` / `-bg` | `x-circle` | Pill | "Absent" |
| `NEEDS_REVIEW` | `--color-warning` / `-bg` | `alert-triangle` | Pill | "Needs review" |
| `NOT_EVALUATED` | `--color-neutral-state` / `-bg` | `help-circle` | Pill | "Needs review" (engine distinction preserved in audit trail) |
| `PROCESSING` | `--color-info` / `-bg` | `loader` (spin) | Pill | "Processing…" |
| `FINALIZED` | `--color-success` outline | `lock` | Outlined pill | "Finalized" |
| `MANUALLY_CORRECTED` | `--color-info` outline | `user-check` | Outlined pill | "Corrected by faculty" |
| `FAILED` / `ERROR` | `--color-danger` outline | `alert-octagon` | Outlined pill | "Error" |

Preservation invariant (from memory `[[attendance-domain-safety-invariants]]`): the visual system must never let `NOT_EVALUATED` **look** finalized as `PRESENT`. Both surface as "Needs review" to the human, matching current behavior in `attendance-stat.tsx:12`.

### 4.5 Color usage rules

- Always pair status color with icon + label; never color alone.
- Text-on-color minimum contrast: 4.5:1 (body), 3:1 (large text ≥18pt/14pt bold).
- Focus ring: `--color-brand-accent` at 2px, 2px offset, always visible on keyboard focus.
- Never use success green for CTAs — reserved for state.
- Never use danger red for CTAs — reserved for state and destructive confirmation.
- Print (`@media print`): status colors are preserved (`print-color-adjust: exact`) because a bar with no ink is meaningless.

### 4.6 Dark mode strategy

- Dark mode is **specified**, not yet implemented across every surface. Future phases wire the toggle.
- Backgrounds shift down the neutral scale (`neutral-900` surface, `neutral-950` canvas) rather than pure black — pure black + white text causes halation on OLED.
- Status hues shift **lighter** (400 range vs. 600 range) to keep contrast on dark surfaces.
- Elevation is expressed via lighter surface, not shadow (shadows are invisible on black).

---

## 5. Typography

### 5.1 Family

- **Sans (primary):** `Geist` (already in use via `next/font/google`). Fallbacks: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
- **Mono:** `Geist Mono` (already in use). Fallbacks: `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`.
- **No third family** unless a future phase adopts a display face for marketing surfaces (out of scope here).

`body { font-family: Arial, Helvetica, sans-serif; }` in current `globals.css` is legacy — future implementation phase should switch body to `var(--font-geist-sans)`. Documented, not changed here.

### 5.2 Type scale (rem, base 16px)

Mobile-first; scales up at `lg` breakpoint only where noted.

| Token | Size | Line-height | Weight | Use |
|---|---|---|---|---|
| `--font-display` | 2rem / 2.25rem `lg` | 1.15 | 700 | Login hero, empty-state hero |
| `--font-page-title` | 1.5rem (24px) | 1.25 | 600 | Route page title (h1) |
| `--font-section` | 1.125rem (18px) | 1.3 | 600 | Section headings inside a page |
| `--font-card-title` | 0.875rem (14px) | 1.35 | 600 | Panel title (matches current `Panel`) |
| `--font-body` | 0.875rem (14px) | 1.5 | 400 | Default body text in app surfaces |
| `--font-body-lg` | 1rem (16px) | 1.55 | 400 | Long-form content, help copy |
| `--font-secondary` | 0.8125rem (13px) | 1.45 | 400 | Descriptions |
| `--font-caption` | 0.75rem (12px) | 1.4 | 400 | Hints, timestamps |
| `--font-label` | 0.75rem (12px) | 1.3 | 500 | Form labels, table headers (uppercase optional, tracking +0.02em) |
| `--font-button` | 0.875rem (14px) | 1 | 500 | Button text |
| `--font-data-lg` | 1.5rem (24px) | 1.15 | 600 | KPI stat value (matches current `StatCard`) |
| `--font-data` | 0.875rem (14px) | 1.5 | 400, `tabular-nums` | Numbers in tables |
| `--font-code` | 0.8125rem (13px) | 1.5 | 400 mono | API keys, IDs |

**Numeric typography rule:** any column of numbers uses `font-variant-numeric: tabular-nums` (already used in `StatCard`). Applies to percentages, counts, IDs.

**Minimum body size** on any surface: 14px (`--font-body`). Below that only for `--font-caption` / labels and never for primary content.

**Line length:** long-form prose (help pages, empty-state descriptions) capped at ~70ch. Table cells: no cap (data has its own width).

---

## 6. Spacing

Systematic 4px-based scale. Names describe purpose, values are the scale.

| Token | Value | Typical use |
|---|---|---|
| `--space-0` | 0 | — |
| `--space-1` | 4px | Icon ↔ text in a badge |
| `--space-2` | 8px | Inline gaps, badge padding-y |
| `--space-3` | 12px | Card internal gaps, form field vertical |
| `--space-4` | 16px | Card padding, section internal spacing |
| `--space-5` | 20px | Card padding (`sm:`), form group |
| `--space-6` | 24px | Section spacing, page top padding |
| `--space-8` | 32px | Between major sections |
| `--space-10` | 40px | Page vertical rhythm on desktop |
| `--space-12` | 48px | Rare — hero spacing |
| `--space-16` | 64px | Landing / empty-state hero only |

### 6.1 Density tiers

The same tokens compose three densities per surface — future phases pick per screen, not per page section.

| Tier | Use | Card padding | Row height | Field gap |
|---|---|---|---|---|
| **Spacious** | Onboarding, login, empty states | `--space-6` | 48px | `--space-4` |
| **Standard** | Dashboards, portal, forms (default) | `--space-4` on mobile, `--space-5` sm+ | 40px | `--space-3` |
| **Dense** | Admin tables, audit logs, roster views | `--space-3` | 32px | `--space-2` |

### 6.2 Responsive padding

| Breakpoint | Page horizontal padding |
|---|---|
| `<640px` (base) | `--space-4` (16px) |
| `≥640px` (`sm`) | `--space-5` (20px) |
| `≥1024px` (`lg`) | `--space-6` (24px) |
| `≥1440px` (`2xl`) | `--space-8` (32px) with max content width 1440px, centered |

---

## 7. Border Radius

| Token | Value | Use |
|---|---|---|
| `--radius-none` | 0 | Table cells, full-bleed elements |
| `--radius-sm` | 4px | Checkbox, small chips |
| `--radius-md` | 6px | Buttons, inputs, selects (matches current `rounded-md`) |
| `--radius-lg` | 8px | Cards, panels, stat cards (matches current `rounded-lg`) |
| `--radius-xl` | 12px | Dialogs, drawers |
| `--radius-2xl` | 16px | Marketing surfaces only |
| `--radius-full` | 9999px | Badges, avatars, progress bars |

No radius above `--radius-xl` inside operational screens. Excessive rounding reads as marketing.

---

## 8. Elevation

Restrained. Elevation communicates *floating over content*, not decoration.

| Token | Shadow | Use |
|---|---|---|
| `--elev-0` | none | Flat surfaces (cards on a canvas) |
| `--elev-1` | `0 1px 2px rgba(0,0,0,0.04), 0 1px 1px rgba(0,0,0,0.03)` | Hover on interactive cards, resting dropdowns |
| `--elev-2` | `0 4px 8px -2px rgba(0,0,0,0.06), 0 2px 4px -2px rgba(0,0,0,0.04)` | Popovers, dropdown menus |
| `--elev-3` | `0 12px 24px -8px rgba(0,0,0,0.12), 0 4px 8px -4px rgba(0,0,0,0.06)` | Dialogs, sheets |
| `--elev-4` | `0 24px 48px -12px rgba(0,0,0,0.18)` | Full-screen drawers, camera modal |

Cards default to **flat + border**, not shadow. Shadow is for *floating* elements only. On dark mode: shadows are replaced by increased surface lightness (`bg-elevated`).

---

## 9. Layout Principles

### 9.1 Application shell (authenticated surfaces)

```
┌────────────────────────────────────────────────────────────────┐
│  Topbar (56px) — logo · role/tenant switcher · search · user   │
├──────────┬─────────────────────────────────────────────────────┤
│          │  Page header (title · breadcrumbs · primary action) │
│ Sidebar  ├─────────────────────────────────────────────────────┤
│ (240px)  │                                                     │
│          │  Content area                                       │
│ collapse │                                                     │
│ → 64px   │                                                     │
└──────────┴─────────────────────────────────────────────────────┘
```

- **Sidebar:** 240px expanded, 64px collapsed (icon-only). Persistent on `≥lg`, off-canvas drawer below.
- **Topbar:** 56px, sticky. Contains tenant/role context, global search (⌘K), user menu.
- **Content max-width:** 1440px on `2xl`, centered. Full-width below.
- **Page header:** always present — title (h1 = `--font-page-title`), optional breadcrumbs above, primary action right-aligned. Sticky within the content column on scroll.
- **Mobile** (`<768px`): sidebar becomes a bottom nav (max 5 items) + drawer for the rest.

### 9.2 Public surfaces (login, unauthorized, offline)

Centered card, no shell. Max width 400px. Vertical rhythm at Spacious density.

### 9.3 Role variants

All four roles use **the same shell**. Differences:

| Role | Sidebar sections | Landing route |
|---|---|---|
| Platform Super Admin | Institutions · Platform admins · System health · Audit · Billing | `/dashboard/platform` |
| Institution Admin | Overview · Campuses · Academic · Faculty · Students · Attendance · Reports · Integrations · Settings | `/dashboard` |
| Faculty | Today · Sessions · Roster · Corrections · Reports | `/portal` |
| Student | Today · My attendance · Enroll face · Profile | `/portal` |

No role gets a "different" visual system. Density may shift (admin = dense, student = standard).

---

## 10. Component Visual Specifications

For each: **shape, sizing, states, when to use.** No installation, no code, no shadcn additions in this phase — this spec informs future mapping (see §22).

### 10.1 Button

| Variant | Fill | Border | Text | Use |
|---|---|---|---|---|
| `primary` (default) | `--color-action-primary` | none | `--color-action-primary-fg` | The one main action per view |
| `secondary` | `--color-bg-surface` | `--color-border-strong` | `--color-text-primary` | Alternative actions |
| `ghost` | transparent | none | `--color-text-primary` | Tertiary actions, toolbars |
| `link` | transparent | none | `--color-brand-accent` | Inline navigation |
| `danger` | `--color-danger` | none | white | Destructive |
| `danger-outline` | `--color-bg-surface` | `--color-danger` | `--color-danger` | Destructive in low-emphasis contexts |

**Sizes:** `sm` (32px h, `--font-caption`), `md` (40px h, `--font-button`, default), `lg` (48px h). Minimum touch target 44×44 on mobile — apply invisible `min-h-11` on tap surfaces below `md`.

**States:**

- Hover: fill −5% luminance (light) / +5% (dark); duration 150ms; `cursor-pointer`.
- Focus-visible: 2px `--color-brand-accent` ring, 2px offset.
- Active: fill −10% luminance; no scale transform.
- Disabled: `--color-text-disabled` text, muted fill, no hover, `cursor-not-allowed`.
- Loading: replace label with spinner + retain button width (no layout shift). Aria `aria-busy="true"`.

Current `Button` in `button.tsx` covers `primary/secondary/danger` — future mapping keeps its API and adds `ghost/link/danger-outline`.

### 10.2 Icon Button

40×40 (`md`), 32×32 (`sm`), 48×48 (`lg`). Same state rules as Button. Always has `aria-label`.

### 10.3 Input

- Height 40px, `--radius-md`, 1px `--color-border-strong` border.
- Focus: border → `--color-brand-accent`, 1px ring same color (matches current `Input`).
- Error: border → `--color-danger`, helper text `--color-danger`.
- Disabled: background → `--color-bg-sunken`, text → `--color-text-disabled`.
- Placeholder ≠ label. Labels are always visible above the field.
- Number/ID inputs use `tabular-nums`.

### 10.4 Password Input

Input + trailing eye toggle (icon button). Toggle is `aria-pressed` and announces "Show/Hide password".

### 10.5 Select / Combobox

- Trigger matches Input.
- Menu on `--elev-2`, `--radius-md`, min-width = trigger width.
- Highlighted row: `--color-bg-sunken` background.
- Keyboard: ↑↓ traverses, Enter selects, Esc closes, type-ahead on Combobox.

### 10.6 Textarea

Same as Input, min-height 80px, resize-y only.

### 10.7 Checkbox / Radio / Switch

- Checkbox: 16px box, `--radius-sm`, checked = `--color-action-primary`.
- Radio: 16px circle, checked dot = `--color-action-primary`.
- Switch: 32×18 track, 14 knob, on = `--color-brand-accent`.
- All: 44×44 hit area on touch. Label clickable.
- Focus ring on the visible control, not the hidden native input.

### 10.8 Date picker

- Popover calendar on `--elev-2`.
- Today: outlined ring in `--color-brand-accent`.
- Selected: filled `--color-action-primary`.
- Range: light `--color-brand-accent-bg` fill between endpoints.
- Keyboard: arrow-key navigation, PageUp/Down = month, Shift+PageUp/Down = year.

### 10.9 Search / Filter

- Search input has leading `search` icon and clears with a trailing `x` when non-empty.
- ⌘K opens a global command palette (future).
- Filter chips: outlined pill, removable, show applied count on the trigger.

### 10.10 Badge / Status Badge

Already spec'd in current `badge.tsx`. Add:

- Outlined variant for state-with-overlay meaning (e.g. Finalized).
- Icon-optional; when icon present, `--space-1` gap.

### 10.11 Avatar

- Circular, `--radius-full`. Sizes 24/32/40/48.
- Initials on `--color-bg-sunken` if no image.
- Do not use skin-tone-assumed colors for initials — always neutral.

### 10.12 Card / Panel

Current `Panel` is the canonical unit. Rules:

- 1px `--color-border-subtle`, `--radius-lg`, `--color-bg-surface`, padding `--space-4`/`--space-5`.
- Header: title (`--font-card-title`) + optional description (`--font-caption`) + optional right-aligned action.
- No shadow by default (see §8).
- Header wraps rather than truncates (preserves current `Panel.tsx:12` decision).

### 10.13 Stat Card

Current `StatCard`. Rules:

- Label (`--font-label`) → Value (`--font-data-lg`, tabular) → optional Hint (`--font-caption`).
- Tone applies to value only, not label.
- In a `StatGrid`: 2-col mobile, 4-col `lg` (current behavior).

### 10.14 Table / Data Table

See §16 for full specification.

### 10.15 Pagination

- Prev / page indicator / Next; ghost buttons.
- Page-size selector adjacent (25/50/100).
- Show total count when known ("101–150 of 3,204").
- Cursor-based lists show only Prev/Next.

### 10.16 Tabs

- Underline style: 2px `--color-brand-accent` under active tab.
- 44px min tap on mobile.
- Overflow → horizontal scroll with edge-fade masks; no dropdown collapse below 3 tabs.

### 10.17 Breadcrumbs

- Above page title on `≥md`; hidden on mobile (back button substitutes).
- Separator: chevron `>`, `--color-text-muted`.
- Last crumb = current page, not a link.

### 10.18 Sidebar

- Sections separated by `--space-4` and a `--color-border-subtle` divider.
- Each item: 40px h, icon + label, `--space-3` gap, `--radius-md`.
- Active: `--color-bg-sunken` background, `--color-brand-accent` left border (2px inset).
- Collapse toggle at footer.
- Tenant switcher lives at the top when a user has cross-tenant scope.

### 10.19 Topbar

- 56px, sticky, `--color-bg-surface`, `--color-border-subtle` bottom border.
- Left: logo + tenant/role indicator. Center: search (`≥md`). Right: notification bell, help, user menu.
- Never houses primary action buttons — those belong to the page header.

### 10.20 Dropdown Menu

- `--elev-2`, `--radius-md`, min-width 180px.
- Item: 32px h, `--font-body`, hover `--color-bg-sunken`.
- Destructive items: `--color-danger` text.
- Section labels: `--font-label` uppercase.

### 10.21 Tooltip

- `--color-text-primary` background on light, `--color-bg-elevated` on dark; opposite text color.
- `--font-caption`, `--radius-sm`, max-width 240px.
- 300ms hover delay in; 0ms out.
- Not the only place a critical label lives.

### 10.22 Popover

- Card-like, `--elev-2`, `--radius-md`, padding `--space-4`.
- Arrow optional.
- Traps focus only when it contains form controls.

### 10.23 Dialog / Modal

- Centered on `≥sm`, bottom-sheet on `<sm`.
- Max-width 480 (`sm`) / 600 (`md`) / 800 (`lg`).
- Backdrop: rgba(0,0,0,0.5); focus trapped; Esc closes.
- Header (title + close) → body → footer (secondary left, primary right).
- Confirmation dialogs (via existing `useConfirm`): title = the question, body = the consequence, primary button = the verb.

### 10.24 Drawer

- Slides from right on desktop (`≥md`), 400/600/800 width.
- Slides from bottom on mobile, up to 90vh.
- `--elev-3` when floating; full-height when snapped.

### 10.25 Sheet

Same visual as Drawer but always full-height. Used for form-heavy edit flows (roster edit, campus edit).

### 10.26 Toast

- Top-right on desktop, top-center on mobile.
- `--elev-2`, `--radius-md`, tone-colored left border 4px.
- Auto-dismiss 4s (info) / 6s (success) / persistent for danger with explicit close.
- Never carries the *only* record of an error.

### 10.27 Alert (inline banner)

- Full-width within its container, `--radius-md`.
- Tone tint background + tone icon + text.
- Optional dismiss.
- Used for page-level warnings (e.g. "You are offline", "Session is unsaved").

### 10.28 Skeleton

- `--color-bg-sunken` fill, subtle shimmer (150ms ease-in-out infinite alternate, 6% luminance sweep).
- Match the shape of the real content — same height, same radius.
- Respect `prefers-reduced-motion` (freeze the shimmer).

### 10.29 Progress

- Linear: 4px track, `--radius-full`, filled `--color-brand-accent`.
- Circular: 16/24/32 sizes, 2px stroke.
- Indeterminate: 20% bar cycling, 1.5s ease.

### 10.30 Empty State

Current `EmptyState` is the pattern. Rules:

- Dashed `--color-border-strong`, `--radius-md`, centered text, `--color-text-muted`.
- With icon: 24px icon above title (`--font-body`), description (`--font-secondary`), optional action button.
- Copy is a sentence, not a word.

### 10.31 Error State

Current `ErrorState`. Rules:

- Icon `alert-triangle` in `--color-danger`.
- Title = what happened; body = what to try; optional Retry action.
- Never blame the user in copy.

### 10.32 Success State

- Icon `check-circle` in `--color-success`.
- Reserved for completed multi-step flows (enrollment finished, session finalized).

### 10.33 Confirmation Dialog

Wraps §10.23. Rules:

- Title states the action ("Delete campus?").
- Body states the consequence ("This will remove 4 subjects and 142 enrollments. This cannot be undone.").
- Primary button uses the verb ("Delete campus"), never "Yes".
- Destructive actions require a typed confirmation for high-blast-radius operations (delete institution, delete tenant).

---

## 11. Dashboard Visual System

Shared across all four roles. Anatomy:

```
Page header  (title, date range, primary action)
KPI row      (2–4 stat cards)
Chart / trend row  (1–2 charts, sparklines)
Data section (table / list / activity feed)
Quick actions (secondary, footer of section)
```

Rules:

- KPI cards: `StatGrid` (2 on mobile, 4 on `lg`).
- Charts: fixed aspect ratio containers to avoid CLS.
- Empty dashboards: single centered `EmptyState` with a primary action ("Create your first session").
- Date range selector lives in the page header, not scattered.

Role differences are IA-only. Super Admin dashboard shows tenant counts, health, audit summary. Institution Admin shows attendance rates, at-risk students, faculty coverage. Faculty shows today's sessions + pending reviews. Student shows their own percentage + subject bars.

---

## 12. Attendance Visual Language

See also §4.4 for state tokens.

### 12.1 Roster row (list treatment)

```
[avatar]  Student name (font-body, primary)      [status badge]  [timestamp]
          Roll number · cohort (font-caption, muted)               
```

- 56px min row on mobile; 40px on desktop dense.
- Divider `--color-border-subtle` between rows.
- Row hover: `--color-bg-sunken`.
- Selected: `--color-bg-sunken` + left border 2px `--color-brand-accent`.
- Long-press / hover reveals correction action.

### 12.2 Session summary card

- Header: date, subject, cohort.
- Body: attendance ratio (23/45) + `RateBar` + percentage.
- Footer: status pills (Finalized / Needs review count / Errors).

### 12.3 AI confidence display

- **Never** show a bare percentage as a certainty.
- Confidence is bucketed: **High** (≥ threshold) → present chip; **Medium** → "Needs review" chip; **Low** → "Not evaluated" chip.
- If exact percentage is shown (faculty review only), always paired with the words "AI confidence" and an "override" affordance.
- Confidence bars use `--color-info` (not success) — this is a machine estimate, not a fact.

### 12.4 Manually-corrected marker

- Small "Corrected by faculty" chip attached to the row.
- Correction source labels sourced from `correctionSourceLabel()` — do not invent new labels.
- Audit trail (who, when, why) accessible via row detail sheet.

---

## 13. Camera / AI UI Visual Principles

**Not implemented in this phase.** Principles only.

| State | Visual treatment |
|---|---|
| Camera permission needed | Full-panel alert with `--color-info` tone, primary "Enable camera" button |
| Camera active | Live viewfinder, thin `--color-brand-accent` frame, capture counter (1/3, 2/3, 3/3) |
| Capture in progress | Momentary white flash overlay (respects reduced-motion — replace with border pulse) |
| Image quality low | Amber overlay with plain-text reason ("Too dark", "Move closer", "Look at camera") |
| Face detected | Green corner brackets around face bbox, non-flashy |
| Processing | Center loader with "Recognizing…" text; do not imply completion |
| Matched | Green check overlay + name + roll number confirmation |
| Uncertain | Amber overlay + "Needs faculty review" — never auto-confirm |
| Unmatched | Neutral gray overlay + "No match" — no red (this is not an error, it is a state) |
| Capture failure | `ErrorState` inline with Retry action |
| Finalization | Confirmation dialog summarizing the session totals before commit |

Visual hierarchy prioritizes the viewfinder. Overlays live at 40% max opacity so the underlying frame remains visible. Never show "100% match" — the highest visual state is "Matched" (word, not number).

---

## 14. Form Design System

- **Labels:** always visible above field, `--font-label`. Required indicator = `*` in `--color-danger` after label, plus `aria-required="true"`.
- **Helper text:** `--font-caption`, `--color-text-muted`, below field. Used to describe format ("YYYY-MM-DD").
- **Errors:** replace helper text with `--font-caption` in `--color-danger` + `alert-triangle` icon, `aria-describedby`. Border → `--color-danger`.
- **Success:** rare; only for async validation (unique email confirmed) — small check in trailing slot.
- **Field grouping:** related fields inside a `Panel`; unrelated groups separated by `--space-8`.
- **Multi-column:** 2 columns on `≥md` for short paired fields (city / postcode). Long fields stay full-width.
- **Field spacing:** `--space-4` between fields, `--space-6` between groups.
- **Submit affordance:** primary button bottom-right (LTR), secondary "Cancel" to its left. On mobile, stack — primary on top.
- **Loading:** disable submit + spinner; do not lock the whole form.
- **Autosave surfaces:** small "Saved · 2s ago" label in muted text; never a toast per keystroke.
- **Mobile:** single column, larger tap targets, appropriate `inputmode` for numeric fields.

---

## 15. Table / Data-Dense UI

- **Row height:** 32 dense / 40 standard / 48 comfortable. Choose per surface.
- **Header:** `--font-label` uppercase, `--color-text-secondary`, `--color-bg-sunken`, sticky on vertical scroll.
- **First column:** identity (name, roll, ID). Left-aligned.
- **Numeric columns:** right-aligned, `tabular-nums`.
- **Status columns:** center-aligned, use `ResultBadge`.
- **Action columns:** last column, right-aligned, icon buttons or "…" menu.
- **Row dividers:** `--color-border-subtle` bottom border, no vertical dividers.
- **Row hover:** `--color-bg-sunken`.
- **Selection:** leading checkbox column; selected row = `--color-bg-sunken` + accent left border.
- **Sort:** clickable header, up/down chevron indicating current direction.
- **Filter:** chip row above table.
- **Search:** input above table, debounced.
- **Pagination:** below, right-aligned; page size selector left.
- **Sticky:** header vertical; first column horizontal on wide data.
- **Empty:** collapse to `EmptyState` inside the table body.
- **Loading:** skeleton rows matching row height and column widths.
- **Mobile fallback:** cards, not scroll-of-death. Each row → stacked card with label:value pairs; primary action full-width at bottom.

Current `TableScroll` primitive is the horizontal-overflow container; future mapping preserves it.

---

## 16. Responsive Design Constraints

Breakpoints (Tailwind defaults, explicit here for clarity):

| Name | Width | Purpose |
|---|---|---|
| `base` | <640px | Phone portrait (target 390px) |
| `sm` | ≥640 | Phone landscape / small tablet |
| `md` | ≥768 | Tablet portrait |
| `lg` | ≥1024 | Small laptop |
| `xl` | ≥1280 | Laptop |
| `2xl` | ≥1440 | Desktop (content max-width caps here) |

Constraints:

- **Minimum touch target:** 44×44 CSS px (WCAG 2.5.5). Non-negotiable on `<md`.
- **Typography scaling:** base 16px root; no fluid clamps in operational surfaces (predictability > cleverness). Marketing surfaces may use `clamp()`.
- **Spacing scaling:** page padding steps at `sm`/`lg`/`2xl` per §6.2. Card padding steps at `sm` (matches current `Panel`).
- **Card behavior:** full-width on base; multi-column grid on `lg`.
- **Grid behavior:** 2 / 4 / 4 / 8 column patterns; align to spacing scale.
- **Navigation behavior:** sidebar → drawer + bottom nav below `md`. Bottom nav has 3–5 items.
- **Table strategy:** horizontal scroll (`md`+) → card fallback (`<md`) per §15.
- **Form behavior:** single column below `md`; two column above where paired.
- **Dialog behavior:** modal on `≥sm`; bottom sheet on `<sm`.
- **Viewport meta:** current `viewport.themeColor` set; do not add `maximumScale`/`userScalable: false` (already deliberately absent per `layout.tsx:44` — respect pinch-zoom).

Full responsive implementation lands in **Prompt 3**.

---

## 17. Accessibility

Target: **WCAG 2.2 AA**, with 2.5.5 (target size) enforced on mobile.

- **Contrast:** 4.5:1 body, 3:1 large / non-text UI (borders, focus rings). Validate every semantic token pair.
- **Focus:** always visible. 2px ring in `--color-brand-accent`, 2px offset. Never `outline: none` without a replacement.
- **Keyboard:** every interactive is tab-reachable; Enter/Space activates; Esc closes overlays; arrow keys in menus and calendars.
- **Semantic status:** color + icon + text, always. No color-only signals.
- **Forms:** labels linked (`for`/`id`), errors via `aria-describedby`, required via `aria-required`.
- **Icons:** decorative icons `aria-hidden="true"`; meaningful icons in buttons get `aria-label`.
- **Live regions:** toasts announced via `role="status"` (info/success) or `role="alert"` (danger).
- **Reduced motion:** honor `prefers-reduced-motion: reduce` — freeze skeletons, remove non-essential transitions, replace flash with border pulse.
- **Language:** `<html lang="en">` set (already in `layout.tsx`).
- **Zoom:** page usable at 200% zoom without horizontal scroll (below `2xl`).
- **RTL readiness:** use logical properties (`padding-inline`, `text-align: start`) so future localization is not a rewrite.
- **Screen reader:** table headers correctly associated, live sort announcements, live filter counts.

---

## 18. Motion

Restrained. Motion communicates state change, not personality.

| Kind | Duration | Easing |
|---|---|---|
| Hover / small state | 100ms | `ease-out` |
| Focus ring | 100ms | `ease-out` |
| Dropdown / popover open | 150ms | `ease-out` |
| Dialog open | 200ms | `ease-out` |
| Drawer slide | 250ms | `cubic-bezier(0.32, 0.72, 0, 1)` |
| Page transition | 200ms opacity | `ease-out` |
| Skeleton shimmer | 1200ms cycle | `ease-in-out` |
| Toast enter/exit | 200 in / 150 out | `ease-out` |

Rules:

- Exit faster than enter (150 vs 200) — feels responsive.
- Never animate `width` / `height` on layout — use `transform` / `opacity`.
- No parallax, no scroll-jack, no marketing-style reveals in operational surfaces.
- Respect `prefers-reduced-motion` for every non-essential animation.
- Loading spinners: `--color-brand-accent`, 20px default, 2px stroke.

---

## 19. Iconography

- **Family:** **Lucide** (SVG, tree-shakeable, consistent 24×24 stroke). Reason: apache-2 license, open, consistent visual weight, aligns with Geist typography aesthetic. No emoji as UI icons.
- **Sizes:** 16 (inline text), 20 (buttons default), 24 (nav, empty states), 32 (illustrative).
- **Stroke:** 1.5px default; 2px for high-emphasis states (danger alerts).
- **Placement:** icon leads text with `--space-1` (badge) / `--space-2` (button) gap.
- **Semantic icons:** consistent choice per meaning (`check-circle` = success everywhere, never `check`; `alert-triangle` = warning; `x-circle` = danger).
- **Accessibility:** decorative → `aria-hidden`; meaningful (icon-only buttons) → `aria-label`.
- No mixing icon families. No pixel-perfect exports from Figma if the SVG doesn't match Lucide stroke — redraw.

---

## 20. Data Visualization

- **Chart library (future recommendation):** Recharts or Visx (React-native SVG, no runtime canvas dep). Choice deferred to implementation phase.
- **Palette:** semantic first (`--color-success` for present, `--color-danger` for absent, `--color-warning` for needs-review). For categorical (e.g. per-subject), use an accessible qualitative palette derived from `--color-brand-accent` at varied lightness — never rainbow.
- **Typography:** axis labels `--font-caption`; values `--font-secondary` tabular; title `--font-card-title`.
- **Grid lines:** `--color-border-subtle`, dashed, minor axis only.
- **Legends:** below chart on mobile, right on desktop. Word + swatch + shape (not swatch-only).
- **Tooltips:** `--elev-2`, `--radius-md`, dark background on light theme for contrast. Show label + value + delta.
- **Empty:** in-chart `EmptyState` — "No data for this range" + adjust dates hint.
- **Loading:** skeleton bars at chart aspect ratio.
- **Trend indicators:** small `arrow-up` / `arrow-down` with colored delta (`--color-success` up, `--color-danger` down — reversed for absence rates: down = good). Delta context text always accompanies ("+2.1% vs last week").
- **Never** convey meaning by color alone — always shape, pattern, or label.

Do not change chart *logic* — this system only styles what future charts will render.

---

## 21. Design Tokens (canonical list)

Tokens are semantic. Consuming components never see raw hex.

### 21.1 Categories

```
--color-*                        (§4)
--font-family-*                  (§5.1)
--font-*                         (§5.2)  size + weight + line-height composites
--space-0..16                    (§6)
--radius-*                       (§7)
--elev-0..4                      (§8)
--z-*                            (see below)
--motion-duration-*              (§18)
--motion-ease-*                  (§18)
--breakpoint-*                   (§16)
```

### 21.2 Z-index scale

| Token | Value |
|---|---|
| `--z-base` | 0 |
| `--z-sticky` | 10 |
| `--z-dropdown` | 20 |
| `--z-overlay` | 30 |
| `--z-modal` | 40 |
| `--z-popover` | 50 |
| `--z-toast` | 60 |

### 21.3 Naming rules

- **Semantic > literal.** `--color-status-success`, not `--color-green`.
- **Purpose > surface.** `--color-bg-surface`, not `--color-card-bg`.
- **No page-scoped tokens.** No `--login-*`, no `--dashboard-*`.
- **Dark mode by CSS custom property override**, not a parallel token set.

### 21.4 Delivery mechanism (recommendation for future phase)

Tokens live in `apps/web/src/app/globals.css` as `@theme inline` (Tailwind v4 native), so `bg-[color:var(--color-bg-surface)]` and utility classes (`bg-surface`) both work. **Do not implement this in Phase 2.** Documented for Phase 3.

---

## 22. shadcn/ui Compatibility Mapping

**shadcn/ui is not installed today** and is not to be installed in Phase 2. Per project memory routing rule, shadcn is the *last-resort* implementation layer, after UX-Designer → UI/UX Pro Max → Mobile-App-UI-Design conclusions are respected.

When future phases add components, prefer **enhancing existing primitives** in `apps/web/src/components/ui/` over introducing shadcn duplicates. Only reach for shadcn when the component genuinely does not exist (dialog, dropdown, combobox, calendar).

Recommended mapping if shadcn is later adopted:

| Design system component | Current primitive | shadcn map (future, if needed) |
|---|---|---|
| Button | `ui/button.tsx` | `button` (extend, don't replace) |
| Badge | `ui/badge.tsx` | `badge` |
| Card / Panel | `ui/panel.tsx` | `card` (Panel wraps it) |
| Input | `ui/input.tsx` | `input` |
| Select | `ui/select.tsx` | `select` |
| Field / Label | `ui/field.tsx` | `label` + `form` |
| Skeleton | `ui/skeleton.tsx` | `skeleton` |
| Table wrapper | `ui/table-scroll.tsx` | `table` |
| Confirmation | `ui/use-confirm.ts` | `alert-dialog` |
| Empty state | `ui/panel.tsx` (`EmptyState`) | — (bespoke) |
| Error state | `ui/error-state.tsx` | — (bespoke) |
| Dialog | *missing* | `dialog` |
| Drawer / Sheet | *missing* | `sheet` |
| Tabs | *missing* | `tabs` |
| Dropdown menu | *missing* | `dropdown-menu` |
| Tooltip | *missing* | `tooltip` |
| Toast | *missing* | `sonner` or `toast` |
| Combobox | *missing* | `command` + `popover` |
| Calendar / Date picker | *missing* | `calendar` + `popover` |
| Switch / Checkbox / Radio | *missing* | `switch` / `checkbox` / `radio-group` |
| Alert | *missing* | `alert` |
| Progress | *missing* | `progress` |
| Avatar | *missing* | `avatar` |

Rule: adding shadcn components does **not** replace existing primitives. They coexist; existing primitives may be refactored to wrap shadcn where the visual outcome is identical.

---

## 23. Do / Don't Rules

### Do

- Use semantic tokens for every color / spacing / radius value.
- Pair every status color with icon + text.
- Keep `NOT_EVALUATED` visually identical to `NEEDS_REVIEW` at the user surface.
- Use `tabular-nums` for every column of numbers.
- Cap primary actions at **one per view** (page header slot).
- Respect the current `Panel` header wrap behavior.
- Respect print rules and offline visual state.
- Honor `prefers-reduced-motion`.
- Preserve the current `viewport` (no pinch-zoom disable).
- Keep dark mode achievable — never hard-code light-only colors.

### Don't

- Don't introduce a second font family without a new spec entry.
- Don't use success green or danger red for CTAs.
- Don't show bare AI confidence percentages as certainties.
- Don't animate layout properties (`width`, `height`, `top`, `left`).
- Don't install shadcn wholesale — map incrementally when needed.
- Don't invent per-page color tokens (`--login-bg`, `--dashboard-blue`).
- Don't use gradients on operational surfaces.
- Don't use decorative shadows on flat cards.
- Don't use emoji as UI icons.
- Don't hide focus rings without a visible replacement.
- Don't rely on hover alone for actions used on touch devices.
- Don't stack more than one modal at a time.
- Don't use rainbow palettes on categorical charts.
- Don't rebrand child screens (Super Admin ≠ different visual system from Institution Admin).

---

## 24. Future Implementation Rules (for Phase 3+)

1. **Phase 3 — Responsive Architecture:** implements §16 constraints — breakpoints, sidebar-to-drawer, table-to-card, dialog-to-sheet, min-touch enforcement. No new visual language; only responsive behavior of what's in this doc.
2. **Phase 4 — Token wiring:** move tokens from this doc into `globals.css` `@theme inline`, refactor primitives in `apps/web/src/components/ui/` to consume tokens. No visual regression allowed.
3. **Phase 5 — Component completion:** add missing primitives (Dialog, Drawer, Tabs, Dropdown, Tooltip, Toast, Combobox, Calendar, Switch/Checkbox/Radio, Alert, Progress, Avatar). Prefer bespoke wrappers over raw shadcn imports.
4. **Phase 6 — Page redesigns:** apply new visual language to routes, one role at a time (Faculty → Student → Institution Admin → Platform Super Admin). Business logic untouched.
5. **Phase 7 — Dark mode:** wire the theme toggle; validate every token pair for contrast.
6. **Phase 8 — Motion pass:** add motion per §18, gated by `prefers-reduced-motion`.
7. **Phase 9 — Charts:** implement dataviz per §20 with a real library. Data source unchanged.
8. **Phase 10 — Accessibility audit:** third-party or automated axe run; fix; document.

Each phase must:

- Preserve all existing business logic, RBAC, tenant isolation, Face AI logic, API contracts, Prisma schema, CI/CD.
- Ship behind visual QA on the four role dashboards.
- Not remove functionality just because this doc doesn't picture it.

---

## Appendix A — Change log

- **2026-09-22 · Phase 2 initial specification.** Author: automated design pass (Claude Opus 4.7). Grounded in read-only reconnaissance of the current app; Phase 1 UX Audit was not present.

---

## Appendix B — File inventory scanned for this spec

- `apps/web/src/app/globals.css` — current CSS baseline (Tailwind v4, `@theme inline`, light/dark via `prefers-color-scheme`, print rules).
- `apps/web/src/app/layout.tsx` — Geist fonts, viewport, service worker registrar.
- `apps/web/src/components/ui/button.tsx` — primary/secondary/danger variants.
- `apps/web/src/components/ui/badge.tsx` — neutral/positive/warning/danger/info tones.
- `apps/web/src/components/ui/panel.tsx` — Panel + EmptyState.
- `apps/web/src/components/ui/input.tsx` — text input.
- `apps/web/src/components/ui/attendance-stat.tsx` — `ResultBadge`, `RatePercent`, `RateBar`, `StatCard`, `StatGrid`, `correctionSourceLabel`.
- `apps/web/src/components/ui/` (also): `select`, `field`, `skeleton`, `table-scroll`, `error-state`, `use-confirm`.
- `apps/web/src/app/` route survey: `login`, `unauthorized`, `offline`, `portal/{attendance,enroll-face,subjects}`, `dashboard/{attendance,institutions,faculty,audit-logs,platform,api-keys,campuses,academic,face-enrollment}`.

End of document.
