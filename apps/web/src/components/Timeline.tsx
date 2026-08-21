import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../markdown.tsx";
import { fmtDuration, fmtMs } from "../format.ts";
import { groupWork, mergeThinking, promptIndex, toolSummary, copyText, loadDraft, type WorkGroup } from "../utils.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { forkSession, sendMessage } from "../init.ts";
import { requestComposerReplace } from "../composerInsert.ts";
import { applyEvent, openSettingsPage, setUiError, useStore } from "../store.ts";
import { api } from "../api.ts";
import {
  COPY_REASONING_NAME,
  JUMP_TO_LATEST_NAME,
  OPEN_TIMELINE_NAME,
  PROMPT_NAV_NAME,
  actionsMenuName,
  assistantArticleName,
  assistantTime,
  completedName,
  copyActionName,
  copyAnnouncement,
  copyJson,
  copyMarkdown,
  draftStateOf,
  forkActionName,
  forkAvailability,
  guardsFromModel,
  mutationErrorMessage,
  promptJumpName,
  reasoningToggleName,
  revertActionName,
  revertAvailability,
  rewindSeedKey,
  sentName,
  timeIso,
  timeShort,
  turnFooterLine,
  userArticleName,
  type ActionAvailability,
  type MutationGuards,
} from "../messageActions.ts";
import { applyComposerSeed, discardComposerSeed, loadSeedRecord } from "../drafts.ts";
import { TIMELINE_CHUNK, TIMELINE_WINDOW, grownLimit, limitToInclude, windowStart } from "../timelineWindow.ts";
import { captureTimelineAnchor, loadTimelineAnchor, restoreScrollDelta, saveTimelineAnchor, type TimelineAnchor } from "../timelineAnchor.ts";
import CopyButton from "./CopyButton.tsx";
import Dialog from "./a11y/Dialog.tsx";
import AttachmentPills from "./AttachmentPills.tsx";
import SelectionMenu from "./SelectionMenu.tsx";
import SlotHost from "./slots/SlotHost.ts";
import type { RenderModel, RenderMessage, ToolMsg, AssistantMsg, TaskActivityMsg, UserMsg } from "../reduce.ts";

/** One announcement per copy/mutation outcome; text is the accessible record,
 *  checkmarks only supplement it. Screen readers ignore repeats, so identical
 *  text gets an invisible nudge (same trick as a11y/live.tsx). */
type Announce = (text: string) => void;

// Merged thinking block (WP4): collapsible with a first-line preview, or a
// plain block when the collapsible pref is off. UX-MSG-ACTIONS: the disclosure
// is a native, keyboard-operable control with a purpose-and-target name and
// truthful expanded state; expanding/collapsing appends no event.
function Thinking({ m, announce }: { m: AssistantMsg; announce?: Announce }) {
  const prefs = useUiSettings();
  const [open, setOpen] = useState(!m.finalized || prefs.thinkingDefaultExpanded);
  const preview = m.reasoning.split("\n").find((l) => l.trim()) ?? "";
  const copyReasoning = async () => {
    const ok = await copyText(m.reasoning);
    announce?.(copyAnnouncement(ok ? "reasoning" : "failed"));
  };
  if (!prefs.collapsibleThinkingBlocks) {
    return <div className="reasoning reasoning-flat"><div className="reasoning-body" dir="auto">{m.reasoning}</div></div>;
  }
  return (
    <details className="reasoning" open={open}>
      <summary
        aria-label={reasoningToggleName(open)}
        aria-expanded={open}
        onClick={(e) => { e.preventDefault(); setOpen((v) => !v); }}
        style={{ display: "flex", gap: 8, alignItems: "baseline" }}
      >
        <span>Thinking{m.finalized ? "" : "…"}</span>
        {!open && <span className="muted" style={{ fontStyle: "italic", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview}</span>}
      </summary>
      {open && (
        <div className="reasoning-body" dir="auto">
          {m.reasoning}
          <div className="reasoning-actions">
            <button className="small-btn" aria-label={COPY_REASONING_NAME} onClick={() => void copyReasoning()}>
              Copy reasoning
            </button>
          </div>
        </div>
      )}
    </details>
  );
}

interface MessageActionEntry {
  key: string;
  label: string;
  name: string; // accessible purpose-and-target name
  run: () => void;
  disabledReason?: string;
  dataAttr?: Record<string, string | number>;
}

/** The action set for one user message or finalized assistant answer. Shared
 *  by the hover/focus desktop row and the persistent touch menu so pointer,
 *  Enter, and Space always produce the same operation. */
function messageActionEntries(
  m: UserMsg | AssistantMsg,
  opts: {
    announce: Announce;
    onRevert?: (message: UserMsg) => void;
    onFork?: (message: UserMsg) => void;
    revert?: ActionAvailability;
    fork?: ActionAvailability;
  },
): MessageActionEntry[] {
  const role = m.kind;
  const doCopy = (format: "markdown" | "json") => {
    void copyText(format === "markdown" ? copyMarkdown(m) : copyJson(m)).then((ok) => {
      opts.announce(copyAnnouncement(ok ? format : "failed"));
    });
  };
  const entries: MessageActionEntry[] = [
    { key: "md", label: "MD", name: copyActionName(role, "markdown"), run: () => doCopy("markdown") },
    { key: "json", label: "JSON", name: copyActionName(role, "json"), run: () => doCopy("json") },
  ];
  if (m.kind === "user" && opts.onRevert) {
    entries.push({
      key: "revert",
      label: "Revert and edit",
      name: revertActionName(m.time),
      run: () => opts.onRevert?.(m),
      ...(opts.revert && !opts.revert.enabled ? { disabledReason: opts.revert.reason } : {}),
      dataAttr: { "data-revert-seq": m.eventSeq },
    });
  }
  if (m.kind === "user" && opts.onFork) {
    entries.push({
      key: "fork",
      label: "Fork and edit",
      name: forkActionName(m.time),
      run: () => opts.onFork?.(m),
      ...(opts.fork && !opts.fork.enabled ? { disabledReason: opts.fork.reason } : {}),
    });
  }
  return entries;
}

function ActionButton({ entry, className }: { entry: MessageActionEntry; className: string }) {
  return (
    <button
      className={className}
      aria-label={entry.name}
      title={entry.disabledReason ?? entry.name}
      disabled={entry.disabledReason !== undefined}
      onClick={entry.run}
      {...(entry.dataAttr ?? {})}
    >
      {entry.label}
    </button>
  );
}

// Semantic time + actions row under a user message or finalized answer. The
// time stays visible; the desktop action buttons reveal on hover/focus-within
// (hidden ones have no pointer hit area); the touch entry is persistent.
//
// UX-TIMELINE-LAYOUT-01 §2.5: the narrow action menu is bounded NORMAL-FLOW
// content immediately after this footer — it pushes later content instead of
// covering its message body, its block size is capped to the visible
// scrollport (internally scrollable beyond that), and opening it reveals it
// through the existing timeline scroll root. Escape/outside press close it,
// action activation closes it, and focus returns to the opener (predecessor
// UX-MSG-ACTIONS contract, placement only).
function MessageMeta({ m, announce, onRevert, onFork, revert, fork }: {
  m: UserMsg | AssistantMsg;
  announce: Announce;
  onRevert?: (message: UserMsg) => void;
  onFork?: (message: UserMsg) => void;
  revert?: ActionAvailability;
  fork?: ActionAvailability;
}) {
  const sessionId = useStore((s) => s.activeSessionId);
  const t = m.kind === "user" ? m.time : assistantTime(m);
  const name = m.kind === "user" ? sentName(t) : completedName(t);
  const entries = messageActionEntries(m, { announce, onRevert, onFork, revert, fork });
  const [menuOpen, setMenuOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback((refocus: boolean) => {
    setMenuOpen(false);
    if (refocus) openerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); closeMenu(true); }
    };
    const onPress = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || openerRef.current?.contains(target)) return;
      // Outside press closes AND restores the opener, matching Escape and
      // action activation (UX-MSG-ACTIONS focus contract). One exception: a
      // press on another interactive control must keep that control's own
      // focus — restoring here would steal a deliberate target (and trap the
      // composer). The restore runs after the press's default focus handling,
      // which would otherwise land on the focusable timeline region.
      const interactive = target instanceof Element
        && target.closest("button, a[href], input, textarea, select, summary, [contenteditable]") !== null;
      closeMenu(false);
      if (!interactive) {
        const opener = openerRef.current;
        requestAnimationFrame(() => opener?.focus());
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPress, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPress, true);
    };
  }, [menuOpen, closeMenu]);
  useEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    if (!menu) return;
    // Cap to the LIVE scrollport so the whole menu always sits inside it
    // (rows beyond the cap scroll internally per §2.5), then reveal it
    // through the existing timeline scroll root. The menu sits BELOW its
    // footer in normal flow, so it can never extend behind the fixed header —
    // even at scrollTop=0 — and never covers the body it belongs to. The
    // reveal region can mount mid-open and shrink the port, so the cap tracks
    // port resizes for as long as the menu stays open.
    const port = menu.closest<HTMLElement>(".timeline");
    const fit = () => {
      if (port) menu.style.maxBlockSize = `${Math.max(44, port.clientHeight - 12)}px`;
      menu.scrollIntoView({ block: "nearest" });
    };
    fit();
    const ro = port && typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : undefined;
    if (ro && port) ro.observe(port);
    menu.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    return () => ro?.disconnect();
  }, [menuOpen]);
  return (
    <>
      <div className="msg-meta">
        <time className="msg-time" dateTime={timeIso(t)} aria-label={name}>{timeShort(t)}</time>
        <div className="msg-actions">
          {entries.map((entry) => <ActionButton key={entry.key} entry={entry} className="small-btn" />)}
        </div>
        <button
          ref={openerRef}
          className="msg-actions-entry"
          aria-label={actionsMenuName(m)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-actions-seq={m.eventSeq}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋯
        </button>
        <SlotHost
          slot="session.message.actions"
          context={{ sessionId, kind: m.kind, messageId: m.id, eventSeq: m.eventSeq }}
        />
      </div>
      {menuOpen && (
        <div ref={menuRef} className="msg-actions-popup" role="menu" aria-label={actionsMenuName(m)}>
          {entries.map((entry) => (
            <button
              key={entry.key}
              role="menuitem"
              className="msg-actions-item"
              aria-label={entry.name}
              title={entry.disabledReason ?? entry.name}
              disabled={entry.disabledReason !== undefined}
              onClick={() => { entry.run(); closeMenu(true); }}
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function AssistantView({
  m,
  announce,
  plan,
}: {
  m: AssistantMsg;
  announce?: Announce;
  plan?: NonNullable<RenderModel["tasks"]>;
}) {
  const hasAnswer = m.text !== "" || !m.finalized;
  const articleProps = hasAnswer
    ? ({ role: "article", "aria-label": assistantArticleName(m.finalized, assistantTime(m)) } as const)
    : undefined;
  return (
    <div className="msg assistant" {...(articleProps ?? {})}>
      <div className="msg-author">
        <span className="msg-avatar agent" aria-hidden="true">p</span>
        <strong>Polyth</strong>
        <time dateTime={timeIso(assistantTime(m))}>{timeShort(assistantTime(m))}</time>
      </div>
      {m.reasoning !== "" && <Thinking m={m} announce={announce} />}
      {hasAnswer && (
        <div className="bubble" dir="auto">{renderMarkdown(m.text || "", m.id)}{!m.finalized && <span className="caret" />}</div>
      )}
      {plan && plan.items.length > 0 && (
        <section className="message-plan-card" aria-label="Current task plan">
          <div className="message-plan-head">
            <span className="message-plan-icon">✓</span>
            <strong>Plan</strong>
            <span>{plan.items.filter((item) => item.status === "done").length} of {plan.items.length}</span>
          </div>
          <div className="message-plan-progress">
            <i style={{ width: `${Math.round((plan.items.filter((item) => item.status === "done").length / plan.items.length) * 100)}%` }} />
          </div>
          <ul>
            {plan.items.slice(0, 5).map((item) => (
              <li key={item.id} className={item.status}>
                <span>{item.status === "done" ? "✓" : item.status === "active" ? "●" : "○"}</span>
                {item.text}
              </li>
            ))}
          </ul>
        </section>
      )}
      {m.finalized && m.text !== "" && announce && <MessageMeta m={m} announce={announce} />}
    </div>
  );
}

// Long tool output stays clamped until "Show all" (UX-37).
function ClampedPre({ cls, text }: { cls: string; text: string }) {
  const [full, setFull] = useState(false);
  const long = text.split("\n").length > 24 || text.length > 2400;
  return (
    <div className="copy-wrap">
      <pre className={`${cls}${full ? " full" : ""}`}>{text}</pre>
      <CopyButton text={text} />
      {long && (
        <button className="small-btn show-all" onClick={() => setFull((v) => !v)}>
          {full ? "Collapse" : "Show all"}
        </button>
      )}
    </div>
  );
}

function ToolCard({ m }: { m: ToolMsg }) {
  const done = m.status !== "pending";
  const inputJson = JSON.stringify(m.input, null, 2);
  const summary = toolSummary(m.input);
  return (
    <details className={`tool-card ${m.status === "error" ? "error" : ""}`} open={!done}>
      <summary className="tool-head">
        <span className="tool-icon">
          {m.status === "pending" ? (
            <span className="spinner" />
          ) : m.status === "done" ? (
            <span className="ok">✓</span>
          ) : (
            <span className="err">✕</span>
          )}
        </span>
        <span className="tool-name">{m.title || m.tool}</span>
        {summary && <span className="mono muted" style={{ fontSize: 11, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>}
        <span className="tool-dur">{m.finishTime !== undefined ? fmtMs(m.finishTime - m.time) : "running…"}</span>
      </summary>
      <div className="tool-body">
        <div className="tool-section">
          <div className="tool-label">{m.tool} input</div>
          <ClampedPre cls="json" text={inputJson} />
        </div>
        {m.error !== undefined && (
          <div className="tool-section error">
            <div className="tool-label">Error</div>
            <ClampedPre cls="json" text={m.error} />
          </div>
        )}
        {m.output !== undefined && (
          <div className="tool-section">
            <div className="tool-label">Output</div>
            <ClampedPre cls="out" text={m.output} />
          </div>
        )}
      </div>
    </details>
  );
}

function TaskActivityRow({ activity }: { activity: TaskActivityMsg }) {
  const label = activity.action === "created"
    ? "Task created"
    : activity.action === "started"
      ? "Task started"
      : activity.action === "completed"
        ? "Task completed"
        : "Task failed";
  return (
    <div className={`task-activity ${activity.action}`}>
      <span className="task-activity-mark" aria-hidden="true">
        {activity.action === "completed" ? "✓" : activity.action === "failed" ? "✕" : "•"}
      </span>
      <span>{label}: {activity.text}</span>
    </div>
  );
}

// Consecutive tool calls fold behind one "Worked for 3m 1s · 4 steps" row.
function WorkedGroup({ g }: { g: WorkGroup }) {
  const failed = g.tools.some((t) => t.status === "error") || g.tasks.some((task) => task.action === "failed");
  const running = g.tools.some((t) => t.status === "pending") || g.tasks.some((task) => task.action === "started");
  const [open, setOpen] = useState(running || failed);
  const updates = g.tasks.length > 0 ? ` · ${g.tasks.length} task ${g.tasks.length === 1 ? "update" : "updates"}` : "";
  return (
    <div className="msg assistant">
      <button className="goal-toggle muted" style={{ fontSize: 11.5, marginBottom: 6 }} onClick={() => setOpen((v) => !v)}>
        <span className="goal-chevron">{open ? "▾" : "▸"}</span>
        {running ? "Working" : "Worked"} for {fmtDuration(g.ms)} · {g.tools.length} steps{updates}
        {failed && <span style={{ color: "var(--red)" }}>· {g.tools.filter((t) => t.status === "error").length} failed</span>}
      </button>
      {open && g.items.map((item) => (
        item.kind === "tool"
          ? <ToolCard key={item.id} m={item} />
          : <TaskActivityRow key={item.id} activity={item} />
      ))}
    </div>
  );
}

function MessageView({ m, announce, plan, onRevert, onFork, revert, fork }: {
  m: RenderMessage;
  announce?: Announce;
  plan?: NonNullable<RenderModel["tasks"]>;
  onRevert?: (message: UserMsg) => void;
  onFork?: (message: UserMsg) => void;
  revert?: ActionAvailability;
  fork?: ActionAvailability;
}) {
  if (m.kind === "user") {
    return (
      <div className="msg user" data-msg-id={m.id} role="article" aria-label={userArticleName(m.time)}>
        <div className="msg-author">
          <span className="msg-avatar" aria-hidden="true">Y</span>
          <strong>You</strong>
          <time dateTime={timeIso(m.time)}>{timeShort(m.time)}</time>
        </div>
        <div className="bubble" dir="auto">
          {renderMarkdown(m.text, m.id)}
          {m.attachments && m.attachments.length > 0 && (
            <AttachmentPills attachments={m.attachments} />
          )}
          {m.raw && m.raw !== m.text && (
            <div className="user-expanded-hint">
              expanded from <code>{m.raw.split("\n")[0] ?? m.raw}</code>
            </div>
          )}
        </div>
        {announce && (
          <MessageMeta m={m} announce={announce} onRevert={onRevert} onFork={onFork} revert={revert} fork={fork} />
        )}
      </div>
    );
  }
  if (m.kind === "assistant") return <AssistantView m={m} announce={announce} plan={plan} />;
  if (m.kind === "task") return <TaskActivityRow activity={m} />;
  return <ToolCard m={m} />;
}

function TimelineDialog({ prompts, onClose, onJump, onRevert, onFork, revert, fork, resolveRestoreFocus }: {
  prompts: UserMsg[];
  onClose: () => void;
  onJump: (id: string) => void;
  onRevert: (message: UserMsg) => void;
  onFork: (message: UserMsg) => void;
  revert: ActionAvailability;
  fork: ActionAvailability;
  resolveRestoreFocus?: (opener: HTMLElement | null) => HTMLElement | null;
}) {
  return (
    <Dialog title="Session timeline" onClose={onClose} resolveRestoreFocus={resolveRestoreFocus}>
      <div className="dialog-head">
        <div>
          <h2>Session timeline</h2>
          <p className="muted">Jump, revert, or branch from any prompt.</p>
        </div>
        <button className="icon-btn" aria-label="Close timeline" onClick={onClose}>×</button>
      </div>
      <div className="timeline-dialog-list">
        {prompts.map((message, index) => (
          <div className="timeline-dialog-row" key={message.id}>
            <button className="timeline-dialog-prompt" onClick={() => { onJump(message.id); onClose(); }}>
              <span className="muted">{index + 1}</span>
              <span dir="auto">{message.text.split("\n").find((line) => line.trim()) || "(empty prompt)"}</span>
            </button>
            <button
              className="small-btn"
              aria-label={revertActionName(message.time)}
              title={revert.enabled ? revertActionName(message.time) : revert.reason}
              disabled={!revert.enabled}
              onClick={() => { onRevert(message); onClose(); }}
            >Revert and edit</button>
            <button
              className="small-btn"
              aria-label={forkActionName(message.time)}
              title={fork.enabled ? forkActionName(message.time) : fork.reason}
              disabled={!fork.enabled}
              onClick={() => { onFork(message); onClose(); }}
            >Fork and edit</button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

// Reserved prompt navigation (UX-TIMELINE-LAYOUT-01 §2.3): ordered,
// window-aware jump chips in the utility region OUTSIDE the scroll root.
// Hover/focus reveals a bounded IN-FLOW preview that grows this region and
// shrinks the scrollport — it never overlays a message or opens off-screen.
function PromptNavigator({ prompts, onJump }: {
  prompts: Array<{ id: string; preview: string; text: string }>;
  onJump: (id: string) => void;
}) {
  const [active, setActive] = useState(-1);
  const shown = active >= 0 ? prompts[active] : undefined;
  return (
    <nav
      className="prompt-nav"
      aria-label={PROMPT_NAV_NAME}
      onMouseLeave={() => setActive(-1)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(-1);
      }}
    >
      <div className="prompt-nav-items">
        {prompts.map((p, i) => (
          <button
            key={p.id}
            className="prompt-nav-item"
            aria-label={promptJumpName(i, prompts.length, p.text)}
            aria-describedby={active === i && shown ? "prompt-nav-preview" : undefined}
            onClick={() => onJump(p.id)}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
          >
            <span className="prompt-nav-dot" aria-hidden="true" />
            <span className="prompt-nav-index">{i + 1}</span>
          </button>
        ))}
      </div>
      {shown && (
        <div className="prompt-nav-preview" id="prompt-nav-preview" role="note">
          <span className="prompt-nav-preview-head">Prompt {active + 1} of {prompts.length}</span>
          <span className="prompt-nav-preview-body" dir="auto">
            {shown.text.trim() === "" ? "(empty prompt)" : shown.text}
          </span>
        </div>
      )}
    </nav>
  );
}

// Footer under the last message once the turn ended: exactly one terminal
// turn's own start/stop and usage (UX-MSG-ACTIONS) — see turnFooterLine().

export default function Timeline({ model }: { model: RenderModel }) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prefs = useUiSettings();
  const sessionId = useStore((s) => s.activeSessionId);
  const [timelineOpen, setTimelineOpen] = useState(false);
  // A prompt chosen from the CLOSING dialog hands focus to the jump target
  // (never back to the dialog opener, never BODY) — §2.3.
  const dialogFocusHandoff = useRef(false);
  // L13 windowing: only the last `limit` rows render (see timelineWindow.ts).
  const [limit, setLimit] = useState(TIMELINE_WINDOW);
  const anchor = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const pendingJump = useRef<string | null>(null);
  const pendingJumpFocus = useRef(false);
  // Latest-reveal state (§2.4): true while the reader holds a position away
  // from the tail, mounting the reserved Jump to latest region.
  const [showJump, setShowJump] = useState(false);
  // UX-PANE-MODEL stable anchor: session switches adjust during render so the
  // outgoing anchor is captured from the STILL-CURRENT DOM (before commit) and
  // the incoming one is ready before the first paint of the new session.
  // Pane dock/expand/full-screen transitions never remount this tree, so the
  // live scroll position carries itself; this record covers reload + switch.
  const restoreRef = useRef<TimelineAnchor | null>(null);
  const [anchorSession, setAnchorSession] = useState<string | null | undefined>(undefined);
  if (anchorSession !== sessionId) {
    const el = ref.current;
    if (anchorSession !== undefined && anchorSession !== null && el !== null) {
      saveTimelineAnchor(anchorSession, captureTimelineAnchor(el, atBottom.current));
    }
    setAnchorSession(sessionId);
    setLimit(TIMELINE_WINDOW);
    const stored = sessionId !== null ? loadTimelineAnchor(sessionId) : null;
    restoreRef.current = stored !== null && !stored.atBottom ? stored : null;
    atBottom.current = stored?.atBottom ?? true;
    setShowJump(stored !== null && !stored.atBottom);
  }

  // Tail follow (§2.4): at/near the tail the timeline follows growth; a reader
  // who scrolled up keeps the chosen position and sees the reveal control.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight >= 80);
    }
  }, [model.version]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottom.current = near;
    setShowJump(!near);
    if (sessionId === null) return;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const now = ref.current;
      if (now) saveTimelineAnchor(sessionId, captureTimelineAnchor(now, atBottom.current));
    }, 200);
  };

  // Debounce safety: reload and unmount flush the stable anchor immediately.
  useEffect(() => {
    if (sessionId === null) return;
    const flush = () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const el = ref.current;
      if (el) saveTimelineAnchor(sessionId, captureTimelineAnchor(el, atBottom.current));
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [sessionId]);

  // One timeline live region: copy results and mutation outcomes are announced
  // as text (visual checkmarks only supplement). Identical repeats get an
  // invisible nudge so assistive tech re-announces them.
  const [liveText, setLiveText] = useState("");
  const liveRef = useRef("");
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announce = useCallback((text: string) => {
    liveRef.current = text === liveRef.current ? `${text}\u00a0` : text;
    setLiveText(liveRef.current);
    clearTimeout(liveTimer.current);
    // The visible chip fades after the announcement has been delivered; the
    // region itself stays mounted so the next announcement still fires.
    liveTimer.current = setTimeout(() => setLiveText(""), 4000);
  }, []);
  useEffect(() => () => clearTimeout(liveTimer.current), []);

  // Truthful eligibility (UX-MSG-ACTIONS): guards derive from the live render
  // model plus the authoritative queue; the server re-validates inside the
  // per-session lock, so a raced action returns a typed conflict, not a lie.
  const archived = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.status === "archived");
  const pendingQuestion = model.questions.some((question) => question.status === "pending");
  const emptyCopy = archived
    ? "This archived session has no messages. Restore it below to continue."
    : pendingQuestion
      ? "Answer the pending question below to continue."
      : "No messages yet.";
  const [queuedCount, setQueuedCount] = useState(0);
  useEffect(() => {
    if (!sessionId) { setQueuedCount(0); return; }
    let cancelled = false;
    void api.queueList(sessionId).then((items) => { if (!cancelled) setQueuedCount(items.length); });
    return () => { cancelled = true; };
  }, [sessionId, model.version]);
  const guards: MutationGuards = guardsFromModel(model, { queuedCount, archived });
  const revertOk = revertAvailability(guards);
  const forkOk = forkAvailability(guards);

  const footer = turnFooterLine(model);
  const visibleMessages = useMemo(() => model.messages.filter((message) => !message.undone), [model.version]);
  const undoneMessages = useMemo(() => model.messages.filter((message) => message.undone), [model.version]);
  const rows = useMemo(() => groupWork(mergeThinking(visibleMessages)), [visibleMessages]);
  const undoneRows = useMemo(() => groupWork(mergeThinking(undoneMessages)), [undoneMessages]);
  const prompts = useMemo(() => promptIndex(visibleMessages), [visibleMessages]);
  const promptMessages = useMemo(
    () => visibleMessages.filter((message): message is UserMsg => message.kind === "user"),
    [visibleMessages],
  );
  const showNav = prefs.promptNavigator === "on" || (prefs.promptNavigator === "auto" && prompts.length >= 3);
  const turn = model.turn;
  const turnBroken = turn && (turn.status === "failed" || turn.status === "aborted");
  const lastUser = [...model.messages].reverse().find((m) => m.kind === "user");

  // L13 windowing: rows render as a suffix; revealing earlier rows keeps the
  // viewport anchored (scrollTop compensates for the height that appeared
  // above), and a jump to a hidden prompt grows the window first.
  const start = windowStart(rows.length, limit);
  const shownRows = start > 0 ? rows.slice(start) : rows;
  const latestAssistantId = [...shownRows].reverse().find((row) => row.kind === "assistant")?.id;
  // A reveal activated from the keyboard can unmount its own control (the
  // final Show earlier chunk, or Show all): focus must then hand off to the
  // named timeline region — never fall to BODY (a11y criteria 6–7).
  const revealHadFocus = useRef(false);
  const reveal = (next: number) => {
    const el = ref.current;
    if (el) anchor.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    const active = document.activeElement;
    revealHadFocus.current = active instanceof Element && active.closest(".timeline-earlier") !== null;
    setLimit(next);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchor.current;
    anchor.current = null;
    if (el && a) el.scrollTop = a.scrollTop + (el.scrollHeight - a.scrollHeight);
    const target = pendingJump.current;
    pendingJump.current = null;
    if (target) {
      const node = el?.querySelector<HTMLElement>(`[data-msg-id="${target}"]`);
      node?.scrollIntoView({ block: "center" });
      if (pendingJumpFocus.current && node) {
        node.tabIndex = -1;
        node.focus({ preventScroll: true });
      }
    }
    pendingJumpFocus.current = false;
    if (revealHadFocus.current) {
      revealHadFocus.current = false;
      // The bar survives a partial reveal and keeps focus itself; only its
      // unmount hands focus to the region (preserving the anchored position).
      if (el && el.querySelector(".timeline-earlier") === null) {
        el.focus({ preventScroll: true });
      }
    }
  }, [limit]);

  // Reapply the stored stable anchor once its row exists: grow the window to
  // include it if needed, then align the row to the remembered usable-edge
  // offset (timelineAnchor.ts owns the inset invariant). Runs every commit
  // but is a no-op unless a restore is pending.
  useLayoutEffect(() => {
    const a = restoreRef.current;
    const el = ref.current;
    if (a === null || a.id === null || el === null) return;
    const node = el.querySelector(`[data-msg-id="${a.id}"]`);
    if (node === null) {
      const index = rows.findIndex((r) => r.kind !== "work" && r.id === a.id);
      if (index >= 0) {
        const next = limitToInclude(rows.length, limit, index);
        if (next !== limit) {
          setLimit(next);
          return; // retry after the window grows
        }
      }
      if (rows.length > 0) restoreRef.current = null; // anchor row is gone
      return;
    }
    restoreRef.current = null;
    el.scrollTop += restoreScrollDelta(el, node, a);
  });
  const jump = (id: string, opts?: { focus?: boolean }) => {
    const index = rows.findIndex((r) => r.kind !== "work" && r.id === id);
    const next = limitToInclude(rows.length, limit, index);
    if (next !== limit) {
      pendingJump.current = id;
      pendingJumpFocus.current = opts?.focus === true;
      setLimit(next);
      return;
    }
    const node = ref.current?.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
    node?.scrollIntoView({ block: "center" });
    if (opts?.focus && node) {
      node.tabIndex = -1;
      node.focus({ preventScroll: true });
    }
  };
  // Jump to latest (§2.4): scroll to the true final surface (error/retry and
  // turn footer included — they precede the tail clearance), mark follow mode
  // active, and hand focus to the latest message container since this control
  // unmounts. Appends no event.
  const jumpToLatest = () => {
    const el = ref.current;
    if (!el) return;
    atBottom.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
    const msgs = el.querySelectorAll<HTMLElement>(":scope > .msg");
    const target = msgs[msgs.length - 1] ?? el;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  };
  // Revert and edit: append the marker, then seed the composer with the exact
  // raw prompt + attachments (marker-owned; replay derives the same draft).
  const revert = (message: UserMsg) => {
    if (!sessionId) return;
    void api.rewind(sessionId, message.eventSeq).then((marker) => {
      applyEvent(marker); // WS re-delivery dedupes by seq
      const draft = {
        text: message.raw ?? message.text,
        ...(message.attachments && message.attachments.length > 0
          ? { attachments: message.attachments }
          : {}),
      };
      applyComposerSeed(sessionId, rewindSeedKey(marker.seq), draft);
      requestComposerReplace(draft.text);
    }).catch((err) => {
      const text = mutationErrorMessage("revert", err);
      announce(text);
      setUiError(text);
    });
  };
  // Fork and edit: navigation happens only after the child is published; a
  // failure keeps the source selected with a bounded explanation (spec).
  const fork = (message: UserMsg) => {
    if (!sessionId) return;
    void forkSession(sessionId, message.eventSeq).catch((err) => {
      const text = mutationErrorMessage("fork", err);
      announce(text);
      setUiError(text);
    });
  };
  // Restore original timeline. An untouched seed is cleared silently; an
  // edited draft asks first (both outcomes named in the dock confirmation).
  // Focus lands on the invoking control when it survives, otherwise on the
  // restored target's Revert action — never on BODY.
  const [confirmRestore, setConfirmRestore] = useState(false);
  const restore = (opts?: { confirmed?: boolean; invoker?: HTMLElement | null }) => {
    if (!sessionId || !model.rewind) return;
    const draftState = draftStateOf(loadSeedRecord(sessionId), loadDraft(sessionId));
    if (draftState === "edited" && !opts?.confirmed) {
      setConfirmRestore(true);
      return;
    }
    const atSeq = model.rewind.atSeq;
    const invoker = opts?.invoker ?? null;
    void api.clearRewind(sessionId).then((cleared) => {
      applyEvent(cleared);
      discardComposerSeed(sessionId);
      requestComposerReplace("");
      setConfirmRestore(false);
      announce("Original timeline restored");
      requestAnimationFrame(() => {
        if (invoker && document.contains(invoker)) { invoker.focus(); return; }
        const el = ref.current;
        const target = el?.querySelector<HTMLElement>(`[data-revert-seq="${atSeq}"]`)
          ?? el?.querySelector<HTMLElement>(`[data-actions-seq="${atSeq}"]`);
        if (target) { target.focus(); return; }
        if (el) { el.focus(); }
      });
    }).catch((err) => {
      const text = mutationErrorMessage("restore", err);
      announce(text);
      setUiError(text);
    });
  };

  // Bounded, already-reduced summary for the timeline before/after hosts —
  // contributions never receive live events or a mutable model reference.
  const slotSummary = {
    sessionId,
    messageCount: model.messages.length,
    promptCount: prompts.length,
    turnStatus: turn?.status ?? null,
  };

  // One timeline, one scroll root (§2.1): the shell stacks the reserved
  // utility region, the single `.timeline` scrollport, and the reserved
  // latest-reveal region as normal-flow siblings. Reserved chrome consumes
  // layout space — nothing is absolutely positioned over the transcript.
  return (
    <div className="timeline-shell">
      {(showNav || promptMessages.length > 0) && (
        <div className="timeline-utility">
          {showNav && <PromptNavigator prompts={prompts} onJump={jump} />}
          {promptMessages.length > 0 && (
            <button
              className="timeline-open small-btn"
              aria-label={OPEN_TIMELINE_NAME}
              aria-haspopup="dialog"
              onClick={() => { dialogFocusHandoff.current = false; setTimelineOpen(true); }}
            >Timeline</button>
          )}
        </div>
      )}
      <div
        className="timeline"
        role="region"
        aria-label="Conversation timeline"
        tabIndex={-1}
        ref={ref}
        onScroll={onScroll}
      >
        <SlotHost slot="session.timeline.before" context={slotSummary} />
        {model.messages.length === 0 && (
          <div className="empty">
            <div>{emptyCopy}</div>
          </div>
        )}
        {start > 0 && (
          <div className="timeline-earlier">
            <button className="small-btn" onClick={() => reveal(grownLimit(rows.length, limit))}>
              Show {Math.min(TIMELINE_CHUNK, start)} earlier
            </button>
            <button className="small-btn" onClick={() => reveal(rows.length)}>
              Show all ({start} hidden)
            </button>
          </div>
        )}
        {shownRows.map((r) => (
          r.kind === "work"
            ? <WorkedGroup key={r.id} g={r} />
            : (
              <MessageView
                key={r.id}
                m={r}
                plan={r.kind === "assistant" && r.id === latestAssistantId && model.tasks ? model.tasks : undefined}
                announce={announce}
                onRevert={revert}
                onFork={fork}
                revert={revertOk}
                fork={forkOk}
              />
            )
        ))}
        {/* The dock confirmation sits OUTSIDE the collapsible tail: it must be
            visible even while the reverted items stay folded away. */}
        {confirmRestore && model.rewind && undoneRows.length > 0 && (
          <div className="rewound-confirm" role="group" aria-label="Confirm restore">
            <span>You edited the draft. Restoring the original timeline discards it.</span>
            <button
              className="small-btn"
              onClick={(event) => restore({ confirmed: true, invoker: event.currentTarget })}
            >Restore and discard the edited draft</button>
            <button className="small-btn" onClick={() => setConfirmRestore(false)}>
              Keep editing the draft
            </button>
          </div>
        )}
        {/* The collapsed tail exists only while the revert is ACTIVE. After a
            replacement the originals stay on disk (and out of model history)
            but no longer occupy the visible timeline. */}
        {model.rewind && undoneRows.length > 0 && (
          <details className="rewound-tail">
            <summary>
              <span>{undoneMessages.length} reverted timeline {undoneMessages.length === 1 ? "item" : "items"}</span>
              {model.rewind && !confirmRestore && (
                <button
                  className="small-btn"
                  onClick={(event) => {
                    event.preventDefault();
                    restore({ invoker: event.currentTarget });
                  }}
                >Restore original timeline</button>
              )}
            </summary>
            <div className="rewound-tail-body">
              {undoneRows.map((row) => (
                row.kind === "work"
                  ? <WorkedGroup key={row.id} g={row} />
                  : <MessageView key={row.id} m={row} announce={announce} />
              ))}
            </div>
          </details>
        )}
        {turnBroken && (
          <div className="turn-error" role="alert">
            <span className="turn-error-text">
              {turn.status === "aborted" ? "Turn aborted" : "Turn failed"}
              {turn.error ? ` — ${turn.error}` : ""}
            </span>
            {turn.error && <CopyButton text={turn.error} />}
            {lastUser && (
              <button className="small-btn" onClick={() => void sendMessage(lastUser.text)}>Retry</button>
            )}
            {turn.status === "failed" && (
              <button className="small-btn" onClick={() => openSettingsPage("models")}>Open settings</button>
            )}
          </div>
        )}
        {footer && <div className="turn-footer">{footer}</div>}
        <div className="msg-live" role="status" aria-live="polite">{liveText}</div>
        <SlotHost slot="session.timeline.after" context={slotSummary} />
      </div>
      {showJump && (
        <div className="timeline-reveal">
          <button className="jump-latest" onClick={jumpToLatest}>
            {turn?.status === "working" && <span className="jump-latest-dot" aria-hidden="true" />}
            {JUMP_TO_LATEST_NAME}
          </button>
        </div>
      )}
      <SelectionMenu container={ref} />
      {timelineOpen && (
        <TimelineDialog
          prompts={promptMessages}
          onClose={() => setTimelineOpen(false)}
          onJump={(id) => { dialogFocusHandoff.current = true; jump(id, { focus: true }); }}
          onRevert={revert}
          onFork={fork}
          revert={revertOk}
          fork={forkOk}
          resolveRestoreFocus={(opener) => (dialogFocusHandoff.current ? null : opener)}
        />
      )}
    </div>
  );
}
