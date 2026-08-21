// UX-PANE-MODEL dock guard (PANE-VERIFY-01/02): settled-layout viability of a
// DOCKED workspace pane, judged from Chat's real DOM — never from the
// constant Chat+pane width sum. The host promotes to the full-screen layer on
// "blocked" and re-checks whenever the composer's own geometry or subtree
// changes (a Model picker mounting late must fail the dock it covers).
//
// Three-valued on purpose:
//   "viable"  — Chat holds the floor and every visible composer action wins
//               its center hit test inside Chat's clip rectangle.
//   "blocked" — the dock squeezes or covers Chat; promote to full-screen.
//   "pending" — Chat is mid-render (boxes not settled yet). NOT a failure:
//               promoting on a transient state and latching would strand the
//               user in full-screen, and un-latching on the promotion's own
//               mode flip is the render loop of PANE-VERIFY-02.

export type DockViability = "viable" | "blocked" | "pending";

/** Chat body containers: the message timeline or the fresh-session stage. */
const TIMELINE_SELECTOR = ".timeline-wrap, .stage";
/** Both composer variants — the hero card is a composer too (a fresh session
 *  with a typed draft was exactly the PANE-VERIFY-02 reload shape). */
const COMPOSER_SELECTOR = ".composer, .composer-hero";
const ACTION_SELECTOR = "button, textarea, [role=button]";

/** True when `hit` reaches `action`'s center through an intentional transient
 *  layer (autocomplete popup, picker menu, dialog): some element on the path
 *  from `hit` up to the chat container is absolutely/fixed positioned. Static
 *  flow collisions — a picker chip painting over Attach files, or the pane
 *  itself covering the composer — have no positioned element on that path. */
function throughLayeredUi(hit: Element, chatEl: Element): boolean {
  const win = chatEl.ownerDocument.defaultView;
  if (!win) return false;
  for (let el: Element | null = hit; el !== null && el !== chatEl; el = el.parentElement) {
    const position = win.getComputedStyle(el).position;
    if (position === "absolute" || position === "fixed") return true;
  }
  return false;
}

/**
 * Judge the ACTUAL post-dock Chat layout. `chatEl` is Chat's workspace
 * container; `chatFloor` is the content-box floor (CHAT_FLOOR).
 */
export function chatDockViability(chatEl: Element | null, chatFloor: number): DockViability {
  if (!chatEl) return "viable"; // nothing to protect (no chat rendered)
  const chat = chatEl.getBoundingClientRect();
  if (chat.width <= 0 || chat.height <= 0) return "pending";
  if (chat.width < chatFloor) return "blocked";

  const timeline = chatEl.querySelector(TIMELINE_SELECTOR);
  const composer = chatEl.querySelector(COMPOSER_SELECTOR);
  // No composer → non-chat primary view or an empty state: only the width
  // floor above constrains the dock.
  if (!composer) return "viable";
  // A composer without its timeline/stage sibling is a partial render.
  if (!timeline) return "pending";
  for (const el of [timeline, composer]) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return "pending";
  }

  const doc = chatEl.ownerDocument;
  for (const action of composer.querySelectorAll(ACTION_SELECTOR)) {
    const r = action.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue; // hidden action: fine
    // Clipping an action outside Chat's rectangle is never success.
    if (r.left < chat.left - 0.5 || r.right > chat.right + 0.5) return "blocked";
    if (typeof doc.elementFromPoint === "function") {
      const hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (
        hit && hit !== action && !action.contains(hit) && !hit.contains(action)
        && !throughLayeredUi(hit, chatEl)
      ) {
        return "blocked";
      }
    }
  }
  return "viable";
}

/** The elements whose geometry feeds the guard: Chat itself, the timeline/
 *  stage, the composer, and EVERY composer action — so resize callbacks see
 *  composer-action geometry, not only the constant Chat+pane sum. */
export function dockGuardTargets(chatEl: Element | null): Element[] {
  if (!chatEl) return [];
  const targets: Element[] = [chatEl];
  const timeline = chatEl.querySelector(TIMELINE_SELECTOR);
  if (timeline) targets.push(timeline);
  const composer = chatEl.querySelector(COMPOSER_SELECTOR);
  if (composer) {
    targets.push(composer);
    for (const action of composer.querySelectorAll(ACTION_SELECTOR)) targets.push(action);
  }
  return targets;
}
