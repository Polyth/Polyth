import { useEffect, useMemo, useRef, useState } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { getState, setPaneFullscreen, useStore } from "../../../apps/web/src/store.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import { parseDiffLines } from "../../../apps/web/src/utils.ts";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { isRtl, tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Badge, Button, ChevronLeftIcon, CloseIcon, ChevronRightIcon, IconButton, Notice, PauseIcon, PlayIcon, Select, SkipBackIcon,
  SkipForwardIcon, VisuallyHidden,
} from "../../../apps/web/src/components/ui/index.ts";
import {
  REPLAY_SPEEDS, clampStep, deriveReplay, lastTurnRange, looksBinary, replayIntervalMs, replayKeyAction, scopeReplay,
  timelineByFile,
} from "../src/replay.ts";
import type { ReplayFileState, ReplayRange } from "../src/replay.ts";

/** The host seams Replay uses; absent on hosts that predate them. */
export type ReplayHost = Pick<WebPackageHost, "conversation" | "navigation">;

/** Tab-panel wiring supplied by WalkthroughView (ids from the host Tabs helpers). */
export interface ReplayPanelProps { id: string; labelledBy: string }

const SURFACE_ID = "walkthrough";
const NOTICE_MS = 6000;

/** Typing targets and open popups keep every key; shortcuts never fire there. */
const isTypingTarget = (t: HTMLElement): boolean =>
  t.isContentEditable || t.getAttribute("aria-expanded") === "true" || t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA"
  || t.getAttribute("role") === "combobox" || t.getAttribute("role") === "listbox" || t.getAttribute("role") === "option";

const baseName = (file: string): string => file.split("/").pop() || file;

/** `unknown` is side-specific: Before lacks the base, After lacks the full result. */
function StatePane({ title, state, unknown }: { title: string; state: ReplayFileState | null; unknown: string }) {
  return (
    <section className="wt-replay-pane" aria-label={title}>
      <header className="wt-replay-pane-title">
        {title}
        {state && !state.complete && <Badge>{tr("walkthroughview.replaySnippetOnly")}</Badge>}
      </header>
      {state && looksBinary(state.text)
        ? <div className="muted wt-replay-unknown">{tr("walkthroughview.replayBinary")}</div>
        : state
        ? <pre className="wt-replay-text" tabIndex={0}>{state.text || " "}</pre>
        : <div className="muted wt-replay-unknown">{unknown}</div>}
    </section>
  );
}

export default function ReplayTheater({ host, panel }: { host?: ReplayHost; panel?: ReplayPanelProps }) {
  const sessionId = useStore((s) => s.activeSessionId);
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined));
  const shellMode = useShellMode();
  const rootRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const [notice, setNotice] = useState<string | null>(null);
  // Workspace roots make paths relative: the session checkout, then the project and its repositories.
  const rootKey = useStore((s) => {
    const session = s.sessions.find((candidate) => candidate.id === s.activeSessionId);
    const project = s.projectRegistry.projects.find((candidate) => candidate.id === (session?.projectId ?? s.activeProjectId));
    return [session?.worktreePath, project?.path, ...(project?.repositories ?? []).map((repository) => repository.path)]
      .filter((root): root is string => !!root).join("\u0000");
  });
  const model = useMemo(() => deriveReplay(events ?? [], { roots: rootKey ? rootKey.split("\u0000") : [] }), [events, rootKey]);
  const [range, setRange] = useState<ReplayRange | null>(null);
  const [fileFilter, setFileFilter] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);

  const effective = range ?? lastTurnRange(model);
  const inRange = useMemo(() => scopeReplay(model.steps, effective), [model, effective.fromTurn, effective.toTurn]);
  const steps = useMemo(() => scopeReplay(model.steps, effective, fileFilter), [model, effective.fromTurn, effective.toTurn, fileFilter]);
  const timeline = useMemo(() => timelineByFile(inRange), [inRange]);
  const at = clampStep(cursor, steps.length);
  const step = steps[at];
  const last = Math.max(0, steps.length - 1);

  useEffect(() => { if (cursor !== at) setCursor(at); }, [cursor, at]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [notice]);

  /** Reveal the prompt that started this turn in the conversation. Where the
   *  module covers Chat (phone layer, fullscreen pane) Chat is inert, so the
   *  layer yields first — focus cannot land in an inert tree — and comes back
   *  with a notice if the host could not show the message. */
  const jumpToMessage = async (seq: number) => {
    setPlaying(false);
    setNotice(null);
    const reveal = host?.conversation.revealEvent;
    if (!sessionId || !reveal) { setNotice(tr("walkthroughview.replayJumpUnavailable")); return; }
    const inPane = !!rootRef.current?.closest(".module-view--main");
    const phone = shellMode === "phone";
    const fullscreen = !phone && getState().paneFullscreen;
    const yieldLayer = inPane && (phone || fullscreen);
    if (yieldLayer) {
      if (phone) host.navigation.closeWorkspacePane();
      else setPaneFullscreen(false);
    }
    let revealed = false;
    try { revealed = await reveal(sessionId, seq, { focus: true }); } catch { revealed = false; }
    if (revealed) return;
    if (yieldLayer) {
      if (phone) host.navigation.openWorkspacePane(SURFACE_ID);
      else setPaneFullscreen(true);
    }
    if (mounted.current) setNotice(tr("walkthroughview.replayJumpFailed"));
  };
  useEffect(() => {
    if (!playing) return;
    if (at >= steps.length - 1) { setPlaying(false); return; }
    const id = window.setTimeout(() => setCursor(at + 1), replayIntervalMs(speed));
    return () => window.clearTimeout(id);
  }, [playing, at, steps.length, speed]);

  const go = (i: number) => { setPlaying(false); setCursor(clampStep(i, steps.length)); };
  const setScope = (next: ReplayRange) => { setRange(next); setFileFilter(new Set()); setCursor(0); setPlaying(false); };
  const toggleFile = (file: string) => {
    setFileFilter((cur) => { const n = new Set(cur); if (n.has(file)) n.delete(file); else n.add(file); return n; });
    setCursor(0);
    setPlaying(false);
  };
  const [chipFocus, setChipFocus] = useState(0);
  const chipAt = Math.min(chipFocus, Math.max(0, timeline.length - 1));
  /** Roving focus: the strip is one Tab stop, arrows move between files. */
  const onChipKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
    let d = keys[e.key];
    if (d === undefined) return;
    e.preventDefault();
    if (isRtl() && Math.abs(d) === 1) d = -d;
    const next = d === -Infinity ? 0 : d === Infinity ? timeline.length - 1 : Math.min(timeline.length - 1, Math.max(0, chipAt + d));
    setChipFocus(next);
    e.currentTarget.querySelectorAll<HTMLButtonElement>(".wt-replay-chip")[next]?.focus();
  };
  const clearFilter = () => { setFileFilter(new Set()); setCursor(0); setPlaying(false); };
  const togglePlay = () => {
    if (!steps.length) return;
    if (!playing && at >= steps.length - 1) setCursor(0);
    setPlaying((p) => !p);
  };
  /** Keys step one notch and stop at the ends; the button wraps around. */
  const stepSpeed = (dir: 1 | -1, wrap = false) => {
    const i = REPLAY_SPEEDS.indexOf(speed as (typeof REPLAY_SPEEDS)[number]);
    const n = REPLAY_SPEEDS.length;
    const next = wrap ? (i + dir + n) % n : Math.min(n - 1, Math.max(0, i + dir));
    setSpeed(REPLAY_SPEEDS[next]!);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (isTypingTarget(t)) return;
    if ((t.tagName === "BUTTON" || t.getAttribute("role") === "button") && (e.key === " " || e.key === "Enter")) return;
    let action = replayKeyAction(e.key, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey });
    if (!action) return;
    // Arrows follow the reading direction, like the progress track.
    if (isRtl() && (action === "next" || action === "prev") && e.key.startsWith("Arrow")) action = action === "next" ? "prev" : "next";
    e.preventDefault();
    if (action === "toggle") togglePlay();
    else if (action === "next") go(at + 1);
    else if (action === "prev") go(at - 1);
    else if (action === "first") go(0);
    else if (action === "last") go(last);
    else if (action === "faster") stepSpeed(1);
    else if (action === "slower") stepSpeed(-1);
    else if (action === "jump" && step?.messageSeq !== undefined) void jumpToMessage(step.messageSeq);
  };

  const rootProps = {
    ref: rootRef,
    tabIndex: 0,
    onKeyDown,
    // A panel focused by pointer stays unringed even once shortcut keys flip it
    // to :focus-visible; only focus that arrives from the keyboard shows the ring.
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => { e.currentTarget.dataset.pointerFocus = ""; },
    onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) delete e.currentTarget.dataset.pointerFocus;
    },
    ...(panel
      ? { role: "tabpanel", id: panel.id, "aria-labelledby": panel.labelledBy }
      : { role: "group", "aria-label": tr("walkthroughview.replayTheater") }),
  } as const;

  if (!model.steps.length) {
    return (
      <div {...rootProps} className="wt-replay wt-replay--empty">
        <EmptyState title={tr("walkthroughview.noFileEditsYet")} description={tr("walkthroughview.writeOrPatchAFileInThis")} />
      </div>
    );
  }

  const turnOptions = Array.from({ length: Math.max(1, model.turnCount) }, (_, i) => ({ value: String(i), label: String(i + 1) }));
  const position = step ? tr("walkthroughview.replayPosition", { index: at + 1, total: steps.length, file: baseName(step.file) }) : "";
  const speedName = tr("walkthroughview.replaySpeed");
  // Announce where playback rests, never every automatic tick.
  const announcement = !playing && step ? position : "";
  const rtl = isRtl();

  return (
    <div {...rootProps} className="wt-replay"
      aria-keyshortcuts="Space K J L ArrowLeft ArrowRight Home End + - M">
      <div className="wt-replay-scope">
        <span className="wt-replay-scope-label" aria-hidden="true">{tr("walkthroughview.replayFromTurn")}</span>
        <Select className="wt-replay-turn" label={tr("walkthroughview.replayFromTurn")} value={String(effective.fromTurn)}
          ariaLabel={`${tr("walkthroughview.replayFromTurn")} ${effective.fromTurn + 1}`}
          options={turnOptions} onChange={(v) => setScope({ ...effective, fromTurn: Number(v) })} />
        <span className="wt-replay-scope-label" aria-hidden="true">{tr("walkthroughview.replayToTurnLabel")}</span>
        <Select className="wt-replay-turn" label={tr("walkthroughview.replayToTurnLabel")} value={String(effective.toTurn)}
          ariaLabel={`${tr("walkthroughview.replayToTurnLabel")} ${effective.toTurn + 1}`}
          options={turnOptions} onChange={(v) => setScope({ ...effective, toTurn: Number(v) })} />
        <Button size="sm" variant="ghost" onClick={() => setScope(lastTurnRange(model))}>{tr("walkthroughview.replayLastTurn")}</Button>
      </div>

      {timeline.length > 1 && (
        <div className="wt-replay-filter">
          <div className="wt-replay-files" role="toolbar" aria-label={tr("walkthroughview.replayFilterFiles")} onKeyDown={onChipKey}>
            {timeline.map(({ file, positions }, i) => (
              <button key={file} type="button" className={`wt-replay-chip${fileFilter.has(file) ? " active" : ""}`}
                tabIndex={i === chipAt ? 0 : -1} onFocus={() => setChipFocus(i)}
                aria-pressed={fileFilter.has(file)} title={file} onClick={() => toggleFile(file)}>
                <span className="wt-replay-chip-name">{baseName(file)}</span>
                <span className="wt-replay-chip-count" aria-label={tr("walkthroughview.replayFileSteps", { count: positions.length })}>{positions.length}</span>
              </button>
            ))}
          </div>
          {fileFilter.size > 0 && (
            <Button size="sm" variant="ghost" className="wt-replay-clear" onClick={clearFilter}>{tr("walkthroughview.replayClearFilter")}</Button>
          )}
        </div>
      )}

      {!step ? (
        <EmptyState title={tr("walkthroughview.replayNoStepsInScope")} description={tr("walkthroughview.replayNoStepsInScopeHint")} />
      ) : (
        <>
          <div className="wt-replay-controls">
            <div className="wt-replay-transport">
              <IconButton size="md" icon={rtl ? SkipForwardIcon : SkipBackIcon} label={tr("walkthroughview.replayFirst")}
                className="wt-replay-first" disabled={at === 0} onClick={() => go(0)} />
              <IconButton size="md" icon={rtl ? ChevronRightIcon : ChevronLeftIcon} label={tr("walkthroughview.replayPrevStep")}
                disabled={at === 0} onClick={() => go(at - 1)} />
              <IconButton size="md" variant="quiet" className="wt-replay-play" icon={playing ? PauseIcon : PlayIcon}
                label={playing ? tr("walkthroughview.replayPause") : tr("walkthroughview.replayPlay")}
                onClick={togglePlay} />
              <IconButton size="md" icon={rtl ? ChevronLeftIcon : ChevronRightIcon} label={tr("walkthroughview.replayNextStep")}
                disabled={at >= last} onClick={() => go(at + 1)} />
              <IconButton size="md" icon={rtl ? SkipBackIcon : SkipForwardIcon} label={tr("walkthroughview.replayLast")}
                className="wt-replay-last" disabled={at >= last} onClick={() => go(last)} />
              {/* Same chrome as the icon buttons beside it; the text is the current value. */}
              <button type="button" className="ui-icon-btn ui-icon-btn--md wt-replay-speed" aria-label={`${speedName} ${speed}×`}
                title={speedName} onClick={() => stepSpeed(1, true)}>{speed}×</button>
            </div>
            <div className="wt-replay-track">
              {/* One step has nowhere to scrub to; the count alone says where playback is. */}
              {steps.length > 1 && <div className="wt-replay-rail">
                <input className="wt-replay-scrub" type="range" min={0} max={last} step={1} value={at}
                  aria-label={tr("walkthroughview.replayScrub")} aria-valuetext={position}
                  onChange={(e) => go(Number(e.target.value))} />
                {/* Pointer convenience sharing the slider's track ends; the slider is the accessible control. */}
                <div className="wt-replay-ticks" aria-hidden="true"
                  onClick={(e) => { const i = (e.target as HTMLElement).dataset.i; if (i !== undefined) go(Number(i)); }}>
                  {steps.map((s, i) => (
                    <span key={s.seq} data-i={i} title={s.file}
                      className={`wt-replay-tick${i === at ? " current" : ""}${i < at ? " done" : ""}`} />
                  ))}
                </div>
              </div>}
              <span className="muted wt-replay-count" aria-hidden="true">{at + 1}/{steps.length}</span>
            </div>
          </div>

          {notice && (
            <Notice tone="warning" className="wt-replay-notice" role="status"
              leading={<IconButton size="sm" icon={CloseIcon} label={tr("common.close")} onClick={() => setNotice(null)} />}>
              {notice}
            </Notice>
          )}

          <VisuallyHidden><span role="status" aria-live="polite" aria-atomic="true">{announcement}</span></VisuallyHidden>

          <div className="wt-card">
            <div className="wt-replay-file">
              <span className="wt-replay-path" title={step.file}><bdi dir="ltr">{step.file}</bdi></span>
              {step.messageSeq !== undefined && (
                <Button size="sm" variant="ghost" className="wt-replay-jump" onClick={() => void jumpToMessage(step.messageSeq!)}>{tr("walkthroughview.replayJumpToMessage")}</Button>
              )}
            </div>
            <div className="wt-replay-states">
              <StatePane title={tr("walkthroughview.replayBefore")} state={step.before} unknown={tr("walkthroughview.replayStateUnknown")} />
              <StatePane title={tr("walkthroughview.replayAfter")} state={step.after.text || step.after.complete ? step.after : null}
                unknown={tr("walkthroughview.replayAfterUnknown")} />
            </div>
            {looksBinary(step.diff) ? (
              <div className="muted wt-replay-unknown">{tr("walkthroughview.replayBinary")}</div>
            ) : <pre className="wt-diff" tabIndex={0} aria-label={tr("walkthroughview.replayDiff")} dir="ltr">
              {parseDiffLines(step.diff).map((line, i) => (
                <div key={i} className={`wt-diff-line ${line.kind}`}>
                  <span className="git-diff-ln">{i + 1}</span>
                  <span>{line.text || " "}</span>
                </div>
              ))}
            </pre>}
          </div>
          <div className="wt-explain">{step.explanation}</div>
          <div className="muted wt-replay-hint">{tr("walkthroughview.replayShortcuts")}</div>
        </>
      )}
    </div>
  );
}
