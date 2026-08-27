# Phase 1 UI Foundation — handoff

Status: **Phase 1 complete** (Waves 1–4). Do not start Phase 2 from this document alone — read `phase-2-candidates.md` for product decisions first.

---

## Completed

- **Wave 1 — Audit:** `phase-1-audit.md`, `component-migration-matrix.md` (38-row inventory, token/primitive/mobile/desktop/cross-platform analysis).
- **Wave 2 — Design system + primitives:** evolved `tokens.css`, `.ui-*` styles in `styles.css`, 23 files under `apps/web/src/components/ui/`, `design-system.md`, `lucide-react` for UI action icons, `ResponsiveOverlay` / `Menu` desktop→sheet degradation, 301-line `uiPrimitives.test.ts`.
- **Wave 3 — Shell + composer:** mobile-first shell CSS aligned with `responsiveShell.ts`, safe-area fixes for header/nav/sheets, composer/header/sidebar migrated to ui primitives, evidence screenshots, `phase-2-candidates.md` seeded.
- **Wave 4 — Independent QA + fix:** drawer focus trap + Escape, single session-row menu trigger, scoped package tap-floor leak, i18n `Submit all` label, `Menu.title` for concise sheet headings; evidence set completed; two new phase-2 candidates (session-row menu migration, package global-rule sweep).

---

## Main files changed

| Area | Paths |
| --- | --- |
| Tokens | `apps/web/src/tokens.css`, `docs/dev/styles.md` |
| Core primitives | `apps/web/src/components/ui/*`, `apps/web/src/styles.css` (`.ui-*` section) |
| Shell | `apps/web/src/components/Header.tsx`, `Sidebar.tsx`, `Composer.tsx`, `sidebar/SessionList.tsx` |
| A11y | `apps/web/src/components/a11y/Dialog.tsx` (focus retry) |
| Permissions i18n | `packages/permissions/widgets/QuestionCards.tsx`, locale keys |
| Package CSS | `packages/files/widgets/styles.css` (scoped tap floor), `packages/models/widgets/styles.css` |
| Docs | `docs/ui-redesign/*` |
| QA scripts | `scripts/ui-*.mjs` |
| Tests | `apps/web/test/uiPrimitives.test.ts`, source-contract tests for header/sidebar/composer |

---

## Validation

| Check | Result |
| --- | --- |
| `npm run build` | pass |
| `npm test` | 1544 pass, 2 skipped, 0 fail |
| `npx tsc --noEmit` (`apps/web`, touched packages) | clean |
| Browser QA (320–1440, light/dark, drawer/sheet/dialog/model picker) | pass with documented gaps below |
| Evidence | 27 PNGs in `docs/ui-redesign/phase-1-evidence/` |

**Not verified in CI/device:** iOS WKWebView keyboard, Android hardware back, Capacitor pinch-zoom policy, live streaming with a real model API key.

---

## Remaining known issues

1. **`styles.css` monolith** — 177 duplicate selectors, ~1,800 lines of package CSS at tail; flatten/repatriate deferred to Phase 2 (see audit §8).
2. **Hand-rolled session-row menu** — not yet on `ui/Menu`; candidate #8 in `phase-2-candidates.md`.
3. **Package global CSS rules** — need sweep for unscoped `:where(button…)` and dead selectors; candidate #9.
4. **Deprecated token aliases** — ~180 live usages; documented, not removed until consumers migrate.
5. **Feature packages untouched** — Git, Terminal, Usage, Browser, etc. still on legacy styling; matrix marks them Phase 1c/2.
6. **Product UX open questions** — seven items in `phase-2-candidates.md` (power composer row, tablet band, Canvas on phone, row action consolidation, …).

---

## Phase 2 candidates

See `docs/ui-redesign/phase-2-candidates.md` (9 items). Start with items marked **Requires product decision: yes** before engineering.

---

## Exact recommended next starting point

1. **Product review** of `phase-2-candidates.md` items 1, 4, 6, 7 (behavior/architecture decisions).
2. **Phase 2a — CSS hygiene:** flatten duplicate core selectors (audit 1a), repatriate package-owned blocks from `styles.css` tail, replace package viewport MQs with container queries (matrix 1c).
3. **Phase 2b — Primitive adoption:** migrate remaining hand-rolled dialogs/menus (`CommandPalette`, `ContextRail`, session-row menu) onto `ui/Dialog` / `ui/Menu` / `ResponsiveOverlay`.
4. **Phase 2c — First feature package:** pick one low-risk panel (e.g. models or permissions) and migrate end-to-end using `design-system.md` as the contract.

**Do not** re-audit or re-implement primitives/shell/composer — build on what Phase 1 shipped.
