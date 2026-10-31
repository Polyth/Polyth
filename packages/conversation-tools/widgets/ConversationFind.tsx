import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { FIND_PAGE_SIZE, FIND_QUERY_MAX, type ConversationFindResult } from "../src/search.ts";
import type { FindController } from "./controller.ts";
import { findStrings } from "./strings.ts";

const transport = createApiTransport();
const searchableEvents = new Set(["user/message", "assistant/message", "turn/stopped", "session/rewound", "session/rewind-cleared"]);

function FindForm({ host, sessionId, focus, close }: {
  host: WebPackageHost; sessionId: string; focus: number; close: () => void;
}) {
  const strings = findStrings(host.ui.locale.get());
  const { Button, IconButton, TextInput } = host.ui.components;
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<ConversationFindResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [navigationError, setNavigationError] = useState("");
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const offset = Math.floor(index / FIND_PAGE_SIZE) * FIND_PAGE_SIZE;
  const current = result?.query === query && result.sessionId === sessionId ? result : null;
  const active = current?.matches.find((match) => match.index === index);
  const lastRevealed = useRef("");

  useEffect(() => { root.current?.querySelector("input")?.focus({ preventScroll: true }); }, [focus]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dispose = host.sessions.subscribeEvents((event) => {
      if (event.sessionId !== sessionId || !searchableEvents.has(event.type)) return;
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((value) => value + 1), 250);
    });
    return () => { dispose(); clearTimeout(timer); };
  }, [host, sessionId]);

  useEffect(() => {
    const request = ++sequence.current;
    const abort = new AbortController();
    setError("");
    setNavigationError("");
    if (!query) { setResult(null); setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query, offset: String(offset) });
      void transport.get<ConversationFindResult>(`/api/conversation/${encodeURIComponent(sessionId)}/find?${params}`, { signal: abort.signal })
        .then((response) => {
          if (abort.signal.aborted || request !== sequence.current) return;
          setResult(response);
          if (index >= response.total) setIndex(Math.max(0, response.total - 1));
        })
        .catch((cause) => {
          if (!abort.signal.aborted && request === sequence.current) {
            setResult(null);
            setError(host.errors.friendly(strings.find, cause));
          }
        })
        .finally(() => { if (!abort.signal.aborted && request === sequence.current) setLoading(false); });
    }, 160);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [host, sessionId, query, offset, revision]);

  useEffect(() => {
    if (!active || !host.conversation.revealEvent) return;
    const key = JSON.stringify([query, active.eventSeq, active.start, active.end]);
    if (lastRevealed.current === key) return;
    const abort = new AbortController();
    setNavigationError("");
    void host.conversation.revealEvent(sessionId, active.eventSeq, { focus: false, signal: abort.signal })
      .then((shown) => {
        if (abort.signal.aborted) return;
        if (shown) lastRevealed.current = key;
        else setNavigationError(strings.unavailable);
      })
      .catch((cause) => { if (!abort.signal.aborted) setNavigationError(host.errors.friendly(strings.find, cause)); });
    return () => { abort.abort(); };
  }, [host, sessionId, query, active?.eventSeq, active?.start, active?.end]);

  const navigate = (direction: number) => {
    if (!current?.total || loading) return;
    setIndex((value) => (value + direction + current.total) % current.total);
  };
  const status = loading ? strings.searching : error ? "" : !query ? strings.empty
    : current?.total ? strings.count.replace("{current}", String(index + 1)).replace("{total}", String(current.total)) : strings.noMatches;
  return <div className="conversation-find" ref={root} role="search" aria-label={strings.find}>
    <div className="conversation-find-controls">
      <TextInput value={query} placeholder={strings.find} aria-label={strings.find} className="conversation-find-input"
        onChange={(event) => {
          const value = event.target.value.slice(0, FIND_QUERY_MAX);
          setQuery(value); setIndex(0); setResult(null); lastRevealed.current = "";
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
          else if (event.key === "Enter") { event.preventDefault(); navigate(event.shiftKey ? -1 : 1); }
        }} />
      <IconButton icon={host.ui.icons.chevronUp} label={strings.previous} variant="ghost" size="sm"
        disabled={loading || !current?.total} onClick={() => navigate(-1)} />
      <IconButton icon={host.ui.icons.chevronDown} label={strings.next} variant="ghost" size="sm"
        disabled={loading || !current?.total} onClick={() => navigate(1)} />
      <IconButton icon={host.ui.icons.close} label={strings.close} variant="ghost" size="sm" onClick={close} />
    </div>
    <div className="conversation-find-status" role="status" aria-live="polite">
      {status}
      {error && <><span>{error}</span><Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>{strings.retry}</Button></>}
      {navigationError && <span>{navigationError}</span>}
    </div>
    {active && <div className="conversation-find-preview" title={strings.source}>
      <span className="conversation-find-role">{active.role === "user" ? strings.user : strings.assistant}</span>{" "}
      {active.before}<mark>{active.hit}</mark>{active.after}
    </div>}
  </div>;
}

/** Renders the modal while a find target exists. Several surfaces may mount
 * this; the controller elects one so a single dialog is ever shown. */
export function FindDialogHost({ host, controller }: { host: WebPackageHost; controller: FindController }) {
  const target = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [token] = useState(() => ({}));
  useEffect(() => controller.attach(token), [controller, token]);
  const primary = useSyncExternalStore(controller.subscribe, () => controller.isPrimary(token));
  if (!target || !primary) return null;
  const strings = findStrings(host.ui.locale.get());
  const Dialog = host.ui.Dialog;
  return <Dialog title={strings.find} onClose={controller.close} className="conversation-find-dialog"
    backdropClassName="conversation-find-backdrop" initialFocus=".conversation-find-input">
    <FindForm key={target.sessionId} host={host} sessionId={target.sessionId} focus={target.focus} close={controller.close} />
  </Dialog>;
}

/** Placeable launcher: an icon button that opens the dialog for its session. */
export function FindLauncher({ host, controller, sessionId }: {
  host: WebPackageHost; controller: FindController; sessionId: string | null;
}) {
  const strings = findStrings(host.ui.locale.get());
  const { IconButton } = host.ui.components;
  const target = sessionId ?? host.store.getSnapshot().activeSessionId;
  return <>
    <IconButton icon={host.ui.icons.search} label={strings.find} variant="ghost" size="sm"
      disabled={!target} onClick={() => { if (target) controller.open(target); }} />
    <FindDialogHost host={host} controller={controller} />
  </>;
}
