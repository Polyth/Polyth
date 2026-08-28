# Phase 3 candidates

## Tablet shell interaction model

**Idea**  
Choose one deliberate shell model for the 481–820px band.

**Existing problem**  
At 768px the product combines a compact icon header, modal project navigation, and bottom session navigation. It works, but mixes desktop and phone interaction patterns.

**Proposed behavior**  
Treat tablets consistently as either a large-phone shell or a compact desktop shell, with one navigation hierarchy in both orientations.

**UX benefit**  
Fewer duplicated destinations and a more predictable orientation change.

**Complexity**  
High; touches shell breakpoints, navigation persistence, and orientation behavior.

**Product decision required**  
Yes — choose large-phone versus compact-desktop behavior.

## Canvas access on phones

**Idea**  
Make the Canvas workspace explicitly available or explicitly unsupported on phones.

**Existing problem**  
The phone chat shell has no clear route to Canvas, so a workspace configured on desktop silently disappears on mobile.

**Proposed behavior**  
Either add Canvas to the mobile workspace destinations or label it as desktop-only in the product.

**UX benefit**  
Removes an unexplained capability gap between devices.

**Complexity**  
Medium if desktop-only messaging is chosen; high if Canvas receives a phone interaction model.

**Product decision required**  
Yes — decide whether Canvas is part of the mobile product.

## Context-window pressure indicator

**Idea**  
Surface context usage only when a conversation approaches its limit.

**Existing problem**  
The removed power-composer row carried a context meter; the simplified composer no longer gives an early warning before context pressure becomes important.

**Proposed behavior**  
Add a quiet meter or warning to the model chip near a product-defined threshold, with details in the model overlay.

**UX benefit**  
Warns users before quality or continuity degrades without restoring permanent composer chrome.

**Complexity**  
Medium; usage data already exists, but thresholds and copy need design.

**Product decision required**  
Yes — define warning thresholds and expected user action.

## Synced model favorites

**Idea**  
Persist model favorites as user preferences instead of browser-local state.

**Existing problem**  
Favorites are useful in large catalogs but do not follow the user across browsers or devices.

**Proposed behavior**  
Sync ordering and favorites through an account-scoped preference contract while retaining an offline fallback.

**UX benefit**  
Keeps the model picker familiar everywhere and reduces repeated catalog curation.

**Complexity**  
Medium to high; requires a preference ownership and conflict policy.

**Product decision required**  
Yes — choose local, project, or account scope.

## Recent attachments

**Idea**  
Offer a privacy-aware recent-attachment shortcut in the composer.

**Existing problem**  
Repeatedly attaching the same working files requires reopening the picker, while the composer currently remembers only pending attachments.

**Proposed behavior**  
Show a short, locally scoped recent list with explicit clearing and missing-file handling.

**UX benefit**  
Speeds repetitive review and debugging workflows.

**Complexity**  
Medium; path privacy, persistence, and stale entries need policy.

**Product decision required**  
Yes — decide retention, scope, and whether paths may persist.

## Package marketplace discovery

**Idea**  
Add discovery tools only when the package catalog outgrows the current settings list.

**Existing problem**  
The package grid is readable at its current size, but a substantially larger catalog would make scanning and comparison slow.

**Proposed behavior**  
Introduce search and category filters, and consider an optional compact density.

**UX benefit**  
Keeps package discovery efficient without making the current catalog unnecessarily complex.

**Complexity**  
Medium.

**Product decision required**  
Yes — define the catalog growth threshold and category taxonomy.

## Browser secondary tools on phones

**Idea**  
Move secondary browser-agent and inspector controls into a dedicated phone sheet.

**Existing problem**  
The primary browser path fits at 320–390px, but secondary tools rely on horizontally constrained toolbar discovery.

**Proposed behavior**  
Keep navigation and address entry visible; place secondary actions in one named, searchable sheet.

**UX benefit**  
Improves discoverability and thumb access without crowding the browser header.

**Complexity**  
Medium.

**Product decision required**  
Yes — choose which browser actions remain primary.

## Additional math delimiters

**Idea**  
Normalize common `\(...\)` and `\[...\]` math delimiters before rendering.

**Existing problem**  
KaTeX renders dollar-delimited math, while valid model output using backslash delimiters falls back to plain text.

**Proposed behavior**  
Recognize the additional delimiters with code-fence and escaping safeguards.

**UX benefit**  
Makes math-heavy answers render consistently across model conventions.

**Complexity**  
Medium; parser ambiguity requires targeted fixtures.

**Product decision required**  
Yes — confirm accepted Markdown dialect and fallback behavior.

## Streaming reasoning reader intent

**Idea**  
Pause a reasoning well's local auto-follow when the reader scrolls upward.

**Existing problem**  
Conversation-level scroll hold works, but an expanded reasoning well can resume following new chunks after the user scrolls within that well.

**Proposed behavior**  
Track local reader position, show a return-to-latest affordance, and resume only on explicit action or when already at the end.

**UX benefit**  
Prevents live content from pulling users away from text they are reading.

**Complexity**  
Low to medium.

**Product decision required**  
No for the interaction principle; yes for whether live reasoning should remain expanded by default.

## Native viewport and back behavior

**Idea**  
Validate zoom, safe areas, software keyboards, and hardware Back on physical iOS and Android targets.

**Existing problem**  
Browser simulations verify the responsive contracts, but cannot prove operating-system inset delivery or Android hardware-back ordering.

**Proposed behavior**  
Define a native overlay-stack policy, preserve accessible page zoom where the shell permits it, and validate real keyboard/orientation transitions.

**UX benefit**  
Prevents browser-correct layouts from failing in installed mobile builds.

**Complexity**  
High; requires native-device coverage and product policy.

**Product decision required**  
Yes — set supported zoom and hardware-back behavior before native implementation.

## Dense label management on phones

**Idea**
Move large session-label sets into a dedicated phone sub-sheet.

**Existing problem**
The session action sheet correctly keeps checkbox entries open for multi-select, but a project with many labels turns the general action list into a long mixed-purpose surface.

**Proposed behavior**
Keep a concise “Labels…” row in session actions and open a searchable multi-select sub-sheet with an explicit Done action.

**UX benefit**
Preserves fast session actions while making large label sets easier to scan and change.

**Complexity**
Medium; requires nested overlay navigation and focus restoration.

**Product decision required**
Yes — define the label-count threshold and whether changes apply immediately or on Done.

## Pinned worktree session treatment

**Idea**
Give pinned sessions with long worktree names a compact, predictable metadata layout.

**Existing problem**
The current worktree pill ellipsizes safely, but at very narrow sidebar widths it competes with the session title and state metadata.

**Proposed behavior**
Choose one secondary-line or abbreviated branch treatment for pinned worktree sessions, with the full branch available on focus or disclosure.

**UX benefit**
Protects session-title readability without hiding worktree identity.

**Complexity**
Low to medium.

**Product decision required**
Yes — choose whether branch identity or session state has priority in narrow rows.

## Permission preview coverage

**Idea**
Extend human-readable permission previews to every common permission kind.

**Existing problem**
Permission requests with a server preview communicate intent and target clearly, while unsupported kinds can fall back to a raw technical request name.

**Proposed behavior**
Add bounded, redacted server-side preview builders for the remaining permission kinds and retain the existing fail-closed fallback.

**UX benefit**
Makes approval decisions faster and safer without exposing raw arguments or secrets.

**Complexity**
Medium; each permission kind needs redaction and fixture coverage.

**Product decision required**
No for readable intent; yes for which request kinds receive priority.

## Effort pricing preview

**Idea**
Explain model-effort cost impact inside the existing effort menu.

**Existing problem**
Effort choices are concise and usable, but users cannot tell whether a higher reasoning level materially changes price or latency when catalog data supports that distinction.

**Proposed behavior**
Show optional relative cost and latency guidance in the effort overlay, never in the permanent composer rail.

**UX benefit**
Supports informed model configuration without reintroducing dense composer chrome.

**Complexity**
Medium; provider metadata is inconsistent and needs honest fallbacks.

**Product decision required**
Yes — define whether guidance is provider-supplied, estimated, or omitted when uncertain.
