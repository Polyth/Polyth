// The folded pending stack: one line above the composer card that says what
// the hidden lines hold, each as its own mark and shortest value, the most
// important line in words. The whole line opens the stack; the open stack's
// fold control sits at the end of its first line. State and the fold itself
// live in @polyth/web-sdk/pending-stack; docs/dev/ui.md "Folding the pending
// stack".
import { useEffect, useRef, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { usePendingStack, type PendingStackEntry } from "@polyth/web-sdk/pending-stack";
import { tr } from "../i18n/index.ts";
import { closeSessionStatusPopover } from "../sessionStatusPopover.ts";
import ComposerNoticeRow from "./ui/ComposerNoticeRow.tsx";
import { ChevronDownIcon, ChevronUpIcon, Icon, IconButton } from "./ui/index.ts";
import "./PendingStackSpine.css";

/** The line that speaks in words: the lowest rank among those that can. */
export function pendingStackLead(entries: readonly PendingStackEntry[]): PendingStackEntry | null {
  let lead: PendingStackEntry | null = null;
  for (const entry of entries) {
    const rank = entry.token.lead?.rank;
    if (rank === undefined) continue;
    if (!lead || rank < lead.token.lead!.rank) lead = entry;
  }
  return lead;
}

/** Keeps the composer's focus (and a phone's keyboard) on a press. */
function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}

export default function PendingStackSpine() {
  const stack = usePendingStack();
  const spineRef = useRef<HTMLButtonElement>(null);
  // Where the keyboard was when the person folded or opened the stack, so the
  // focus follows to the control that undoes it.
  const handoff = useRef<"spine" | "fold" | null>(null);
  const active = stack?.state.active ?? false;
  const foldHost = stack?.state.foldHost ?? null;
  useEffect(() => {
    const target = handoff.current;
    if (!target) return;
    handoff.current = null;
    const frame = requestAnimationFrame(() => {
      if (target === "spine") spineRef.current?.focus();
      else foldHost?.querySelector<HTMLElement>(":scope > .pending-stack-fold")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, foldHost]);
  if (!stack) return null;
  const { store, state } = stack;
  const lead = pendingStackLead(state.entries);
  const labels = state.entries.map((entry) => entry.token.label).join(", ");

  const open = (event: MouseEvent<HTMLButtonElement>) => {
    if (document.activeElement === event.currentTarget) handoff.current = "fold";
    store.setFolded(false);
  };
  const fold = (event: MouseEvent<HTMLButtonElement>) => {
    if (document.activeElement === event.currentTarget) handoff.current = "spine";
    // The run details grow out of the status line: they close with it.
    closeSessionStatusPopover();
    store.setFolded(true);
  };

  return (
    <>
      <ComposerNoticeRow open={state.active}>
        <button
          ref={spineRef}
          type="button"
          className="pending-stack-spine"
          aria-expanded={false}
          aria-label={tr("composer.stack.unfold", { items: labels })}
          title={tr("composer.stack.unfoldHint")}
          onMouseDown={keepFocus}
          onClick={open}
        >
          <span className="pending-stack-row" {...(state.entries.length >= 4 ? { "data-crowded": "" } : {})}>
          {state.entries.map((entry) => {
            const { token } = entry;
            const speaks = entry === lead;
            return (
              <span
                key={entry.key}
                className="pending-stack-token"
                data-token={token.id}
                {...(speaks ? { "data-lead": "" } : {})}
                {...(token.attention ? { "data-attention": "" } : {})}
              >
                <span className="pending-stack-mark" aria-hidden="true" {...(token.accent ? { "data-accent": "" } : {})}>
                  {token.icon}
                </span>
                {speaks && <span className="pending-stack-lead" aria-hidden="true">{token.lead!.text}</span>}
                {token.value && <span className="pending-stack-value" aria-hidden="true">{token.value}</span>}
                {speaks && token.lead!.hint && <kbd className="pending-stack-key" aria-hidden="true">{token.lead!.hint}</kbd>}
              </span>
            );
          })}
          <Icon icon={ChevronUpIcon} size="sm" className="pending-stack-chevron" />
          </span>
        </button>
      </ComposerNoticeRow>
      {foldHost && createPortal(
        <IconButton
          className="pending-stack-fold"
          icon={ChevronDownIcon}
          label={tr("composer.stack.fold")}
          size="sm"
          variant="ghost"
          aria-expanded
          onMouseDown={keepFocus}
          // What the press folds lights up first: under a mouse or a keyboard
          // focus, never a tap (it would flash just before the fold).
          onPointerEnter={(event) => { if (event.pointerType === "mouse") store.setPreview(true); }}
          onPointerLeave={() => store.setPreview(false)}
          onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) store.setPreview(true); }}
          onBlur={() => store.setPreview(false)}
          onClick={fold}
        />,
        foldHost,
      )}
    </>
  );
}
