import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../markdown.tsx";
import { fmtCost, fmtDuration, fmtMs, fmtTokens } from "../format.ts";
import { groupWork, mergeThinking, messageJson, promptIndex, toolSummary, copyText, type WorkGroup } from "../utils.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { sendMessage } from "../init.ts";
import { requestComposerInsert } from "../composerInsert.ts";
import { openSettingsPage } from "../store.ts";
import CopyButton from "./CopyButton.tsx";
import type { RenderModel, RenderMessage, ToolMsg, AssistantMsg } from "../reduce.ts";

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
function MessageActions({ m }: { m: RenderMessage }) {
  const [flash, setFlash] = useState("");
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

// Consecutive tool calls fold behind one "Worked for 3m 1s · 4 steps" row.
function WorkedGroup({ g }: { g: WorkGroup }) {
  const failed = g.tools.some((t) => t.status === "error");
  const running = g.tools.some((t) => t.status === "pending");
  const [open, setOpen] = useState(running || failed);
  return (
    <div className="msg assistant">
      <button className="goal-toggle muted" style={{ fontSize: 11.5, marginBottom: 6 }} onClick={() => setOpen((v) => !v)}>
        <span className="goal-chevron">{open ? "▾" : "▸"}</span>
        {running ? "Working" : "Worked"} for {fmtDuration(g.ms)} · {g.tools.length} steps
        {failed && <span style={{ color: "var(--red)" }}>· {g.tools.filter((t) => t.status === "error").length} failed</span>}
      </button>
      {open && g.tools.map((t) => <ToolCard key={t.id} m={t} />)}
    </div>
  );
}

function MessageView({ m }: { m: RenderMessage }) {
  if (m.kind === "user") {
    return (
      <div className="msg user" data-msg-id={m.id}>
        <div className="bubble">
          {renderMarkdown(m.text, m.id)}
          {m.raw && m.raw !== m.text && (
            <div className="user-expanded-hint">
              expanded from <code>{m.raw.split("\n")[0] ?? m.raw}</code>
            </div>
          )}
        </div>
        <MessageActions m={m} />
      </div>
    );
  }
  if (m.kind === "assistant") return <AssistantView m={m} />;
  return <ToolCard m={m} />;
}

// Floating rail of user prompts; click jumps the timeline to that prompt (WP4).
function PromptNavigator({ prompts, container }: {
  prompts: Array<{ id: string; preview: string }>;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const jump = (id: string) => {
    container.current?.querySelector(`[data-msg-id="${id}"]`)?.scrollIntoView({ block: "center" });
  };
  return (
    <nav className="prompt-nav" aria-label="Prompts in this session">
      {prompts.map((p, i) => (
        <button key={p.id} className="prompt-nav-item" title={p.preview || `Prompt ${i + 1}`} onClick={() => jump(p.id)}>
          <span className="prompt-nav-dot" aria-hidden="true" />
          <span className="prompt-nav-label">{p.preview || `Prompt ${i + 1}`}</span>
        </button>
      ))}
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
  const rows = useMemo(() => groupWork(mergeThinking(model.messages)), [model.version]);
  const prompts = useMemo(() => promptIndex(model.messages), [model.version]);
  const showNav = prefs.promptNavigator === "on" || (prefs.promptNavigator === "auto" && prompts.length >= 3);
  const turn = model.turn;
  const turnBroken = turn && (turn.status === "failed" || turn.status === "aborted");
  const lastUser = [...model.messages].reverse().find((m) => m.kind === "user");

  return (
    <div className="timeline" ref={ref} onScroll={onScroll}>
      {showNav && <PromptNavigator prompts={prompts} container={ref} />}
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
      {rows.map((r) => (
        r.kind === "work" ? <WorkedGroup key={r.id} g={r} /> : <MessageView key={r.id} m={r} />
      ))}
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
    </div>
  );
}
