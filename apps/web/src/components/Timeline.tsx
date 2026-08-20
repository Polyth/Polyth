import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../markdown.tsx";
import { fmtCost, fmtDuration, fmtMs, fmtTokens } from "../format.ts";
import { groupWork, mergeThinking, messageJson, promptIndex, toolSummary, copyText, type WorkGroup } from "../utils.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { forkSession, sendMessage } from "../init.ts";
import { requestComposerInsert, requestComposerReplace } from "../composerInsert.ts";
import { openSettingsPage, setUiError, useStore } from "../store.ts";
import { api } from "../api.ts";
import { TIMELINE_CHUNK, TIMELINE_WINDOW, grownLimit, limitToInclude, windowStart } from "../timelineWindow.ts";
import CopyButton from "./CopyButton.tsx";
import Dialog from "./a11y/Dialog.tsx";
import AttachmentPills from "./AttachmentPills.tsx";
import SelectionMenu from "./SelectionMenu.tsx";
import SlotHost from "./slots/SlotHost.ts";
import type { RenderModel, RenderMessage, ToolMsg, AssistantMsg, TaskActivityMsg, UserMsg } from "../reduce.ts";

// Merged thinking block (WP4): collapsible with a first-line preview, or a
// plain block when the collapsible pref is off.
function Thinking({ m }: { m: AssistantMsg }) {
  const prefs = useUiSettings();
  const [open, setOpen] = useState(!m.finalized || prefs.thinkingDefaultExpanded);
  const preview = m.reasoning.split("\n").find((l) => l.trim()) ?? "";
  if (!prefs.collapsibleThinkingBlocks) {
    return <div className="reasoning reasoning-flat"><div className="reasoning-body">{m.reasoning}</div></div>;
  }
  return (
    <details className="reasoning" open={open}>
      <summary
        onClick={(e) => { e.preventDefault(); setOpen((v) => !v); }}
        style={{ display: "flex", gap: 8, alignItems: "baseline" }}
      >
        <span>Thinking{m.finalized ? "" : "…"}</span>
        {!open && <span className="muted" style={{ fontStyle: "italic", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview}</span>}
      </summary>
      {open && <div className="reasoning-body">{m.reasoning}</div>}
    </details>
  );
}

// Copy as Markdown / copy as JSON, shown on hover (WP4 message actions).
function MessageActions({ m, onRewind, onFork }: {
  m: RenderMessage;
  onRewind?: (message: UserMsg) => void;
  onFork?: (message: UserMsg) => void;
}) {
  const [flash, setFlash] = useState("");
  const sessionId = useStore((s) => s.activeSessionId);
  const doCopy = async (label: string, text: string) => {
    const ok = await copyText(text);
    setFlash(ok ? `${label} ✓` : "copy failed");
    setTimeout(() => setFlash(""), 1400);
  };
  const md = m.kind === "tool" ? "" : m.text;
  return (
    <div className="msg-actions">
      {flash && <span className="msg-actions-flash">{flash}</span>}
      {md !== "" && (
        <button className="small-btn" title="Copy message as Markdown" onClick={() => void doCopy("Markdown", md)}>MD</button>
      )}
      <button className="small-btn" title="Copy message as JSON" onClick={() => void doCopy("JSON", messageJson(m))}>JSON</button>
      {m.kind === "user" && onRewind && (
        <button className="small-btn" title="Rewind to before this prompt" onClick={() => onRewind(m)}>Rewind</button>
      )}
      {m.kind === "user" && onFork && (
        <button className="small-btn" title="Fork a new session from this prompt" onClick={() => onFork(m)}>Fork</button>
      )}
      <SlotHost
        slot="session.message.actions"
        context={{ sessionId, kind: m.kind, messageId: m.id, eventSeq: m.eventSeq }}
      />
    </div>
  );
}

function AssistantView({ m }: { m: AssistantMsg }) {
  return (
    <div className="msg assistant">
      {m.reasoning !== "" && <Thinking m={m} />}
      {(m.text !== "" || !m.finalized) && (
        <div className="bubble">{renderMarkdown(m.text || "", m.id)}{!m.finalized && <span className="caret" />}</div>
      )}
      {m.finalized && m.text !== "" && <MessageActions m={m} />}
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

function MessageView({ m, onRewind, onFork }: {
  m: RenderMessage;
  onRewind?: (message: UserMsg) => void;
  onFork?: (message: UserMsg) => void;
}) {
  if (m.kind === "user") {
    return (
      <div className="msg user" data-msg-id={m.id}>
        <div className="bubble">
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
        <MessageActions m={m} onRewind={onRewind} onFork={onFork} />
      </div>
    );
  }
  if (m.kind === "assistant") return <AssistantView m={m} />;
  if (m.kind === "task") return <TaskActivityRow activity={m} />;
  return <ToolCard m={m} />;
}

function TimelineDialog({ prompts, onClose, onJump, onRewind, onFork }: {
  prompts: UserMsg[];
  onClose: () => void;
  onJump: (id: string) => void;
  onRewind: (message: UserMsg) => void;
  onFork: (message: UserMsg) => void;
}) {
  return (
    <Dialog title="Session timeline" onClose={onClose}>
      <div className="dialog-head">
        <div>
          <h2>Session timeline</h2>
          <p className="muted">Jump, rewind, or branch from any prompt.</p>
        </div>
        <button className="icon-btn" aria-label="Close timeline" onClick={onClose}>×</button>
      </div>
      <div className="timeline-dialog-list">
        {prompts.map((message, index) => (
          <div className="timeline-dialog-row" key={message.id}>
            <button className="timeline-dialog-prompt" onClick={() => { onJump(message.id); onClose(); }}>
              <span className="muted">{index + 1}</span>
              <span>{message.text.split("\n").find((line) => line.trim()) || "(empty prompt)"}</span>
            </button>
            <button className="small-btn" onClick={() => { onRewind(message); onClose(); }}>Rewind</button>
            <button className="small-btn" onClick={() => { onFork(message); onClose(); }}>Fork</button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

// Floating rail of user prompts; click jumps the timeline to that prompt (WP4).
// L13 (OC#2054/#2211): hovering or focusing an item shows a preview card with
// the bounded full prompt, so the rail answers "which prompt was that?"
// without scrolling away.
function PromptNavigator({ prompts, onJump }: {
  prompts: Array<{ id: string; preview: string; text: string }>;
  onJump: (id: string) => void;
}) {
  const [hover, setHover] = useState(-1);
  const shown = hover >= 0 ? prompts[hover] : undefined;
  return (
    <nav className="prompt-nav" aria-label="Prompts in this session" onMouseLeave={() => setHover(-1)}>
      {prompts.map((p, i) => (
        <button
          key={p.id}
          className="prompt-nav-item"
          onClick={() => onJump(p.id)}
          onMouseEnter={() => setHover(i)}
          onFocus={() => setHover(i)}
        >
          <span className="prompt-nav-dot" aria-hidden="true" />
          <span className="prompt-nav-label">{p.preview || `Prompt ${i + 1}`}</span>
        </button>
      ))}
      {shown && (
        <div className="prompt-nav-preview" role="tooltip">
          <div className="prompt-nav-preview-head">Prompt {hover + 1} of {prompts.length}</div>
          <div className="prompt-nav-preview-body">{shown.text || "(empty prompt)"}</div>
        </div>
      )}
    </nav>
  );
}

// Footer under the last message once the turn ended and usage exists.
// Failed/aborted turns keep their footer too — the error card carries the rest (UX-01).
function turnFooter(model: RenderModel): string | null {
  const t = model.turn;
  const hasUsage = model.totals.input + model.totals.output + model.totals.cost > 0;
  if (!t || t.status === "working" || !hasUsage) return null;
  const bits: string[] = [];
  if (t.model) bits.push(`${t.model.providerID}/${t.model.modelID}`);
  if (t.agent) bits.push(t.agent);
  const last = model.messages[model.messages.length - 1];
  const lastUser = [...model.messages].reverse().find((m) => m.kind === "user");
  if (last && lastUser) bits.push(`worked ${fmtDuration(last.time - lastUser.time)}`);
  if (model.totals.input + model.totals.output > 0) {
    bits.push(`${fmtTokens(model.totals.input)} in · ${fmtTokens(model.totals.output)} out`);
  }
  if (model.totals.cost > 0) bits.push(fmtCost(model.totals.cost));
  return bits.join(" · ");
}

const STARTERS = ["Explain this codebase", "Fix a failing test", "Review my latest changes"];

export default function Timeline({ model }: { model: RenderModel }) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prefs = useUiSettings();
  const sessionId = useStore((s) => s.activeSessionId);
  const [timelineOpen, setTimelineOpen] = useState(false);
  // L13 windowing: only the last `limit` rows render (see timelineWindow.ts).
  const [limit, setLimit] = useState(TIMELINE_WINDOW);
  const anchor = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const pendingJump = useRef<string | null>(null);

  useEffect(() => { setLimit(TIMELINE_WINDOW); }, [sessionId]);

  useEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [model.version]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const footer = turnFooter(model);
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
  const reveal = (next: number) => {
    const el = ref.current;
    if (el) anchor.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    setLimit(next);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchor.current;
    anchor.current = null;
    if (el && a) el.scrollTop = a.scrollTop + (el.scrollHeight - a.scrollHeight);
    const target = pendingJump.current;
    pendingJump.current = null;
    if (target) el?.querySelector(`[data-msg-id="${target}"]`)?.scrollIntoView({ block: "center" });
  }, [limit]);
  const jump = (id: string) => {
    const index = rows.findIndex((r) => r.kind !== "work" && r.id === id);
    const next = limitToInclude(rows.length, limit, index);
    if (next !== limit) {
      pendingJump.current = id;
      setLimit(next);
      return;
    }
    ref.current?.querySelector(`[data-msg-id="${id}"]`)?.scrollIntoView({ block: "center" });
  };
  const rewind = (message: UserMsg) => {
    if (!sessionId) return;
    void api.rewind(sessionId, message.eventSeq).then(() => {
      requestComposerReplace(message.raw ?? message.text);
    }).catch((err) => setUiError(`Couldn’t rewind: ${err instanceof Error ? err.message : String(err)}`));
  };
  const fork = (message: UserMsg) => {
    if (!sessionId) return;
    void forkSession(sessionId, message.eventSeq).catch(
      (err) => setUiError(`Couldn’t fork: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
  const restore = () => {
    if (!sessionId) return;
    void api.clearRewind(sessionId).catch(
      (err) => setUiError(`Couldn’t restore: ${err instanceof Error ? err.message : String(err)}`),
    );
  };

  // Bounded, already-reduced summary for the timeline before/after hosts —
  // contributions never receive live events or a mutable model reference.
  const slotSummary = {
    sessionId,
    messageCount: model.messages.length,
    promptCount: prompts.length,
    turnStatus: turn?.status ?? null,
  };

  return (
    <div className="timeline" ref={ref} onScroll={onScroll}>
      {showNav && <PromptNavigator prompts={prompts} onJump={jump} />}
      {promptMessages.length > 0 && (
        <button className="timeline-open small-btn" onClick={() => setTimelineOpen(true)}>Timeline</button>
      )}
      <SlotHost slot="session.timeline.before" context={slotSummary} />
      {model.messages.length === 0 && (
        <div className="empty">
          <div>No messages yet — say hi below.</div>
          <div className="chip-row" style={{ justifyContent: "center", marginTop: 12 }}>
            {STARTERS.map((s) => (
              <button key={s} className="chip" onClick={() => requestComposerInsert(s)}>{s}</button>
            ))}
          </div>
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
          : <MessageView key={r.id} m={r} onRewind={rewind} onFork={fork} />
      ))}
      {undoneRows.length > 0 && (
        <details className="rewound-tail">
          <summary>
            <span>{undoneMessages.length} hidden timeline {undoneMessages.length === 1 ? "item" : "items"}</span>
            {model.rewind && <button className="small-btn" onClick={(event) => { event.preventDefault(); restore(); }}>Restore</button>}
          </summary>
          <div className="rewound-tail-body">
            {undoneRows.map((row) => (
              row.kind === "work"
                ? <WorkedGroup key={row.id} g={row} />
                : <MessageView key={row.id} m={row} />
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
      <SlotHost slot="session.timeline.after" context={slotSummary} />
      <SelectionMenu container={ref} />
      {timelineOpen && (
        <TimelineDialog
          prompts={promptMessages}
          onClose={() => setTimelineOpen(false)}
          onJump={jump}
          onRewind={rewind}
          onFork={fork}
        />
      )}
    </div>
  );
}
