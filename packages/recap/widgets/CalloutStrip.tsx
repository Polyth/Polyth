import { Fragment, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import {
  AssistIcon,
  Button,
  Checkbox,
  ChevronDownIcon,
  CloseIcon,
  Icon,
  IconButton,
  ReplyIcon,
  VisuallyHidden,
  WrenchIcon,
  type LucideIcon,
} from "../../../apps/web/src/components/ui/index.ts";
import { CALLOUT_ORDER, extractCallouts, mergeCallouts, type Callout, type CalloutKind } from "../src/callouts.ts";
import {
  calloutsCollapsed, dismissCallouts, dismissedCallouts, setCalloutDone, setCalloutsCollapsed, subscribeDismissed,
} from "./calloutDismissals.ts";
import { assistSettings, loadAssistSettings, subscribeAssistSettings } from "./assistSettings.ts";

const api = createApiTransport();

const FALLBACK: Record<string, string> = {
  "callouts.label": "Key callouts from the last turn",
  "callouts.title": "Before you continue",
  "callouts.dismissAll": "Dismiss all",
  "callouts.open": "Show in message",
  "callouts.askModel": "Find more",
  "callouts.askModelHint": "Ask a small model for anything else you shouldn't miss",
  "callouts.checking": "Checking…",
  "callouts.modelNothing": "The model found nothing more.",
  "callouts.modelAdded": "The model found {count} more.",
  "callouts.modelFailed": "Couldn't check with the model",
  "callouts.fromModel": "Found by model",
  "callouts.markDone": "Mark as done",
  "callouts.more": "Show {count} more",
  "callouts.reply": "Reply",
  "callouts.askFix": "Ask to fix",
  "callouts.askVerify": "Ask to verify",
  "callouts.fixPrompt": "Please investigate this failure and fix it.",
  "callouts.verifyPrompt": "Please run this check and tell me the result.",
  "callouts.kind.action": "To do",
  "callouts.kind.risk": "Risk",
  "callouts.kind.failed-check": "Check failed",
  "callouts.kind.unverified": "Not verified",
  "callouts.kind.decision": "Decision",
  "callouts.kind.credential": "Manual step",
};

/** What waits on the person right now carries a dot by its kind. */
const URGENT = new Set<CalloutKind>(["decision", "failed-check"]);

/** What the agent can do next about a callout: a reply draft, never a send. */
const NEXT: Partial<Record<CalloutKind, { label: string; icon: LucideIcon; prompt?: string }>> = {
  decision: { label: "callouts.reply", icon: ReplyIcon },
  "failed-check": { label: "callouts.askFix", icon: WrenchIcon, prompt: "callouts.fixPrompt" },
  unverified: { label: "callouts.askVerify", icon: WrenchIcon, prompt: "callouts.verifyPrompt" },
};

/** A long list shows its most urgent items first and folds the rest. */
const FOLD_OVER = 5;
const FOLD_TO = 4;

/** The quote keeps the assistant's words; `code` spans read as code. */
function Quote({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <>
      {parts.map((part, index) => part.length > 2 && part.startsWith("`") && part.endsWith("`")
        ? <code key={index} dir="ltr">{part.slice(1, -1)}</code>
        : <Fragment key={index}>{part}</Fragment>)}
    </>
  );
}

type ModelCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "done"; atSeq: number; callouts: Callout[] }
  | { state: "failed"; atSeq: number; message: string };

export default function CalloutStrip({ host, sessionId }: { host: WebPackageHost; sessionId: string }) {
  const showCallouts = useSyncExternalStore(subscribeAssistSettings, () => assistSettings()?.showCallouts === true);
  const version = () => host.sessions.events(sessionId).at(-1)?.seq ?? 0;
  useSyncExternalStore(host.sessions.subscribe, version, version);
  const dismissedVersion = useSyncExternalStore(subscribeDismissed, () => dismissedCallouts(sessionId).key);
  const collapsed = useSyncExternalStore(subscribeDismissed, calloutsCollapsed);
  const [model, setModel] = useState<ModelCheck>({ state: "idle" });
  const [unfolded, setUnfolded] = useState(false);
  const flight = useRef(0);
  const listId = useId();
  // A late reply after unmount or a session switch must not land anywhere.
  useEffect(() => () => { flight.current += 1; }, [sessionId]);
  // The strip can mount before the composer's suggestion source has loaded
  // the shared settings; one request per page load fills that gap.
  useEffect(() => {
    if (assistSettings() === null) void loadAssistSettings().catch(() => {});
  }, []);
  const translate = host.ui.locale.translate;
  const tr = (key: string, values?: Record<string, string | number>) => {
    const value = translate(key, values);
    if (value !== key) return value;
    return (FALLBACK[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => String(values?.[name] ?? match));
  };

  const events = host.sessions.events(sessionId);
  const extracted = useMemo(() => extractCallouts(events), [events]);
  const modelItems = model.state === "done" && model.atSeq === extracted.atSeq ? model.callouts : [];
  const state = useMemo(() => dismissedCallouts(sessionId), [sessionId, dismissedVersion]);
  const current = state.atSeq === extracted.atSeq;
  const merged = mergeCallouts(extracted.callouts, modelItems);
  const items = merged.filter((item) => !(current && state.ids.has(item.id)));
  if (!extracted.atSeq || items.length === 0 || !showCallouts) return null;

  const atSeq = extracted.atSeq;
  // Every row ticks off: a step done, a question answered, a risk taken in.
  const isDone = (item: Callout) => current && state.done.has(item.id);
  const dismiss = (...ids: string[]) => dismissCallouts(sessionId, atSeq, ids);
  const draft = (item: Callout, prompt?: string) => {
    const quoted = `> ${item.quote}\n\n`;
    host.conversation.insert(prompt ? `${quoted}${tr(prompt)}` : quoted);
  };
  const askModel = () => {
    if (model.state === "checking") return;
    const token = ++flight.current;
    setModel({ state: "checking" });
    void api.post<{ callouts: Callout[]; atSeq: number }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/assist/callouts`, {},
    ).then((result) => {
      if (flight.current === token) setModel({ state: "done", atSeq: result.atSeq || atSeq, callouts: result.callouts });
    }).catch((error: unknown) => {
      if (flight.current !== token) return;
      const code = (error as { code?: string }).code;
      // A newer turn already replaced these callouts; nothing to report.
      if (code === "stale" || code === "no-completed-turn") setModel({ state: "idle" });
      else setModel({ state: "failed", atSeq, message: host.errors.friendly(tr("callouts.modelFailed"), error) });
    });
  };

  const checking = model.state === "checking";
  const checked = model.state === "done" && model.atSeq === atSeq;
  // Only what the model surfaced beyond the heuristic pass and the cap counts.
  const added = merged.filter((item) => item.source === "model").length;
  let status: ReactNode = null;
  if (checking) status = tr("callouts.checking");
  else if (checked) status = added ? tr("callouts.modelAdded", { count: added }) : tr("callouts.modelNothing");
  else if (model.state === "failed" && model.atSeq === atSeq) status = model.message;
  const failed = model.state === "failed" && status !== null;

  const open = items.filter((item) => !isDone(item));
  const tally = CALLOUT_ORDER
    .map((kind) => [kind, open.filter((item) => item.kind === kind).length] as const)
    .filter(([, count]) => count > 0);
  // What the person just asked the model for is never folded away.
  const folded = !unfolded && !checked && items.length > FOLD_OVER;
  const shown = folded ? items.slice(0, FOLD_TO) : items;

  return (
    <section
      className="assist-strip callout-strip"
      aria-label={tr("callouts.label")}
      data-collapsed={collapsed || undefined}
    >
      <header className="callout-head">
        <button
          type="button"
          className="callout-toggle"
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={() => setCalloutsCollapsed(!collapsed)}
        >
          <span className="callout-title">{tr("callouts.title")}</span>
          {!collapsed && open.length > 0 ? <span className="callout-total">{open.length}</span> : null}
          {collapsed ? (
            <span className="callout-tally">
              {tally.map(([kind, count]) => (
                <span key={kind} className={`callout-count callout-${kind}`} data-urgent={URGENT.has(kind) || undefined}>
                  {tr(`callouts.kind.${kind}`)} <span className="callout-count-n">{count}</span>
                </span>
              ))}
            </span>
          ) : null}
          <Icon icon={ChevronDownIcon} size="sm" className="callout-chevron" />
        </button>
        <div className="callout-head-actions">
          {!collapsed && !checked ? (
            <Button
              size="sm"
              variant="ghost"
              className="callout-ask"
              iconStart={AssistIcon}
              busy={checking}
              title={tr("callouts.askModelHint")}
              onClick={askModel}
            >
              {tr("callouts.askModel")}
            </Button>
          ) : null}
          <IconButton
            icon={CloseIcon}
            size="sm"
            variant="ghost"
            className="callout-dismiss-all"
            label={tr("callouts.dismissAll")}
            onClick={() => dismiss(...items.map((item) => item.id))}
          />
        </div>
      </header>
      {collapsed ? null : (
        <>
          <ul className="callout-list" id={listId}>
            {shown.map((item, index) => {
              const done = isDone(item);
              const next = done ? undefined : NEXT[item.kind];
              // A run of one kind names it once; later rows keep the name for
              // assistive technology only.
              const continues = index > 0 && shown[index - 1]!.kind === item.kind;
              const body = (
                <>
                  <q className="callout-quote" dir="auto"><Quote text={item.quote} /></q>
                  {item.source === "model" ? (
                    <span className="callout-from-model" title={tr("callouts.fromModel")}>
                      <Icon icon={AssistIcon} size="sm" />
                      <VisuallyHidden>{tr("callouts.fromModel")}</VisuallyHidden>
                    </span>
                  ) : null}
                </>
              );
              return (
                <li
                  key={item.id}
                  className={`callout callout-${item.kind}`}
                  data-source={item.source}
                  data-done={done || undefined}
                  data-continues={continues || undefined}
                  data-next={next ? "" : undefined}
                  data-urgent={URGENT.has(item.kind) || undefined}
                >
                  <Checkbox
                    className="callout-check"
                    checked={done}
                    onChange={(value) => setCalloutDone(sessionId, atSeq, item.id, value)}
                    label={<VisuallyHidden>{`${tr("callouts.markDone")}: ${item.quote}`}</VisuallyHidden>}
                  />
                  {host.conversation.revealEvent ? (
                    <button
                      type="button"
                      className="callout-text callout-open"
                      title={tr("callouts.open")}
                      onClick={() => void host.conversation.revealEvent?.(sessionId, item.seq, { focus: true })}
                    >
                      {body}
                    </button>
                  ) : <div className="callout-text">{body}</div>}
                  <span className="callout-trail">
                    <span className={continues ? "callout-kind sr-only" : "callout-kind"}>
                      {tr(`callouts.kind.${item.kind}`)}
                    </span>
                    {next ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="callout-act"
                        iconStart={next.icon}
                        onClick={() => draft(item, next.prompt)}
                      >
                        {tr(next.label)}
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          {folded ? (
            <Button size="sm" variant="ghost" className="callout-more" onClick={() => setUnfolded(true)}>
              {tr("callouts.more", { count: items.length - FOLD_TO })}
            </Button>
          ) : null}
        </>
      )}
      <p className={`callout-status${failed ? " callout-status-failed" : ""}`} role="status">
        {collapsed ? null : status}
      </p>
    </section>
  );
}
