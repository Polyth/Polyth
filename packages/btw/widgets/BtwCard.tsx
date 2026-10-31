// The By the way card: floats above the composer of the chat it belongs to,
// shows the side question and its answer, and keeps earlier follow-ups as
// one-line rows. Ephemeral (see store.ts); never part of the transcript.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { BtwStrings } from "../src/strings.ts";
import { BtwIcon, CheckGlyph, InsertIcon } from "./icons.tsx";
import type { BtwEntry, BtwStore, BtwThread } from "./store.ts";

export const BTW_MODE_ID = "btw";
/** Matches the exit animation in styles.css (`--motion-normal`). */
const EXIT_MS = 180;
const COPIED_MS = 1_600;

const motionReduced = (): boolean => {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.reduceAnimations === "true") return true;
  if (document.body?.dataset.desktopLowResource === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
};

/** Keep the last thread on screen while the card plays its exit. */
function useLeaving(thread: BtwThread | undefined): { shown: BtwThread | undefined; leaving: boolean } {
  const [held, setHeld] = useState(thread);
  useEffect(() => {
    if (thread) { setHeld(thread); return; }
    if (!held) return;
    if (motionReduced()) { setHeld(undefined); return; }
    const timer = setTimeout(() => setHeld(undefined), EXIT_MS);
    return () => clearTimeout(timer);
    // `held` only seeds the exit; a new thread restarts the cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread]);
  return { shown: thread ?? held, leaving: !thread && Boolean(held) };
}

function useActiveMode(host: WebPackageHost, sessionId: string): string | null {
  const composer = host.composer;
  return useSyncExternalStore(
    (listener) => composer?.subscribe(listener) ?? (() => {}),
    () => composer?.activeMode?.(sessionId) ?? null,
    () => null,
  );
}

export function qaText(strings: BtwStrings, entry: Pick<BtwEntry, "question" | "answer">): string {
  return `${strings.question}: ${entry.question}\n${strings.answer}: ${entry.answer ?? ""}\n`;
}

export function BtwCardSlot({ host, store, sessionId, strings }: {
  host: WebPackageHost;
  store: BtwStore;
  sessionId: string;
  strings: BtwStrings;
}) {
  const thread = useSyncExternalStore(store.subscribe, () => store.get(sessionId), () => undefined);
  const { shown, leaving } = useLeaving(thread);
  if (!shown || shown.entries.length === 0) return null;
  return <BtwCard host={host} store={store} thread={shown} leaving={leaving} strings={strings} />;
}

function BtwCard({ host, store, thread, leaving, strings }: {
  host: WebPackageHost;
  store: BtwStore;
  thread: BtwThread;
  leaving: boolean;
  strings: BtwStrings;
}) {
  const { IconButton, Button, MarkdownDoc } = host.ui.components;
  const { sessionId, entries } = thread;
  const latest = entries.at(-1)!;
  const earlier = entries.slice(0, -1);
  const answered = [...entries].reverse().find((entry) => entry.status === "answered");
  const inMode = useActiveMode(host, sessionId) === BTW_MODE_ID;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const close = () => {
    const focusWasInside = cardRef.current?.contains(document.activeElement) ?? false;
    if (host.composer?.activeMode?.(sessionId) === BTW_MODE_ID) host.composer.setMode?.(null, { sessionId });
    store.close(sessionId);
    if (focusWasInside) document.querySelector<HTMLElement>("[data-composer-input]")?.focus();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Newest pinned to the bottom of the card's own scroll area.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [entries.length, latest.status]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // Esc closes the card from inside it, or from this chat's empty composer
  // when the composer is not in a mode (the composer consumes Esc to leave
  // its mode first, so the card closes on the next one).
  useEffect(() => {
    if (leaving) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const inCard = Boolean(target && cardRef.current?.contains(target));
      const inEmptyComposer = target instanceof HTMLTextAreaElement
        && target.matches("[data-composer-input]") && target.value === "";
      if (!inCard && !inEmptyComposer) return;
      if (!inCard && host.store.getSnapshot().activeSessionId !== sessionId) return;
      if (!inCard && host.composer?.activeMode?.(sessionId)) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [host, sessionId, leaving]);

  const copy = async () => {
    if (!answered?.answer) return;
    try {
      await navigator.clipboard.writeText(answered.answer);
      setCopied(true);
    } catch (error) {
      host.errors.show?.(host.errors.friendly(strings.copy, error));
    }
  };
  const addToChat = () => {
    if (!answered) return;
    if (host.composer?.activeMode?.(sessionId) === BTW_MODE_ID) host.composer.setMode?.(null, { sessionId });
    host.conversation.insert(qaText(strings, answered));
  };
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <section
      ref={cardRef}
      className="btw-card"
      data-state={leaving ? "leaving" : "open"}
      aria-label={strings.title}
      inert={leaving || undefined}
    >
      <header className="btw-card-head">
        <span className="btw-card-badge"><BtwIcon size={14} />{strings.title}</span>
        <span className="btw-card-actions">
          <IconButton
            icon={copied ? CheckGlyph : host.ui.icons.copy}
            label={copied ? strings.copied : strings.copy}
            size="sm"
            variant="ghost"
            disabled={!answered}
            onClick={() => void copy()}
          />
          <IconButton icon={InsertIcon} label={strings.addToChat} size="sm" variant="ghost" disabled={!answered} onClick={addToChat} />
          <IconButton icon={host.ui.icons.close} label={strings.close} size="sm" variant="ghost" onClick={close} />
        </span>
      </header>
      <div ref={scrollRef} className="btw-card-scroll">
        {earlier.length > 0 && (
          <ol className="btw-earlier" aria-label={strings.earlier}>
            {earlier.map((entry) => {
              const open = expanded.has(entry.id);
              return (
                <li key={entry.id} className="btw-earlier-item" data-open={open || undefined}>
                  <button
                    type="button"
                    className="btw-earlier-row"
                    aria-expanded={open}
                    title={open ? strings.hideAnswer : strings.showAnswer}
                    onClick={() => toggle(entry.id)}
                  >
                    <span className="btw-earlier-question">{entry.question}</span>
                    <span className="btw-earlier-chevron" aria-hidden="true">{host.ui.icons.chevronDown?.()}</span>
                  </button>
                  {open && (
                    <div className="btw-earlier-answer">
                      {entry.status === "answered" && entry.answer
                        ? <MarkdownDoc text={entry.answer} keyBase={`btw-${entry.id}`} />
                        : <p className="btw-muted">{entry.status === "failed" ? strings.failed : strings.thinking}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <p className="btw-question" title={latest.question}>{latest.question}</p>
        <div className="btw-current" aria-live="polite" aria-busy={latest.status === "pending" || undefined}>
          {latest.status === "pending" && (
            <div className="btw-thinking">
              <span className="btw-skeleton" aria-hidden="true"><span /><span /><span /></span>
              <span className="btw-thinking-label">{strings.thinking}</span>
            </div>
          )}
          {latest.status === "answered" && (
            <div key={latest.id} className="btw-answer">
              <MarkdownDoc text={latest.answer ?? ""} keyBase={`btw-${latest.id}`} />
            </div>
          )}
          {latest.status === "failed" && (
            <div className="btw-error" role="alert">
              <span className="btw-error-text">{latest.error ? `${strings.failed}. ${latest.error}` : strings.failed}</span>
              <Button size="sm" variant="quiet" iconStart={host.ui.icons.refresh} onClick={() => store.retry(sessionId, latest.id)}>
                {strings.retry}
              </Button>
            </div>
          )}
        </div>
      </div>
      <footer className="btw-card-foot">
        <span className="btw-card-note">{strings.ephemeral}</span>
        {!inMode && host.composer?.setMode && (
          <Button size="sm" variant="ghost" className="btw-follow-up" onClick={() => host.composer?.setMode?.(BTW_MODE_ID, { sessionId })}>
            {strings.followUp}
          </Button>
        )}
      </footer>
    </section>
  );
}
