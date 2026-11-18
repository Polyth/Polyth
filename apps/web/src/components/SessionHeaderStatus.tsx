import type { MouseEvent } from "react";
import SlotHost, { type SlotContext } from "./slots/SlotHost.ts";

/** What a package mark can press on its own: its controls answer the click,
 *  the session title's button must not. */
const MARK_CONTROL = "button, a[href], input, select, textarea, label, summary, [role='button'], [role='link'], [role='menuitem']";

/** Package marks (`session.header.status`) sit inside the session title's
 *  button, so a click they handle would also reach the title and open the
 *  session overview on top of the mark's own window. React also carries a
 *  click from a mark's portaled dialog or sheet up through this span, though
 *  the DOM puts it under `body`. Those clicks stop here; a click on a plain
 *  glyph (the isolation lock, a marker) still opens the overview. */
export function keepMarkClicksToThemselves(event: MouseEvent<HTMLElement>): void {
  const host = event.currentTarget;
  const target = event.target as Element;
  if (!host.contains(target)) {
    event.stopPropagation();
    return;
  }
  const control = typeof target.closest === "function" ? target.closest(MARK_CONTROL) : null;
  if (control && control !== host && host.contains(control)) event.stopPropagation();
}

/** The `session.header.status` widget area beside the title in the desktop
 *  header and in the phone's title island. */
export default function SessionHeaderStatus({ context }: { context: SlotContext }) {
  return <span className="session-header-status" onClick={keepMarkClicksToThemselves}>
    <SlotHost slot="session.header.status" context={context} />
  </span>;
}
