import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JsonObject, SessionProjection } from "@polyth/contracts";
import { api, errorCodeOf, httpStatusOf } from "@polyth/session/web-api";
import { fmtMs } from "../format.ts";
import {
  executionPresentation,
  normalizedMcpResult,
  normalizedInputEntries,
  outputLineCount,
  type ExecutionKind,
} from "../execution.ts";
import { applyUnifiedDiff, visibleDiffRows, type DiffApplyDirection, type FileDiff } from "../diff.ts";
import { highlight, langOf } from "../highlight.ts";
import { Icon } from "../icons.tsx";
import { openSession } from "../init.ts";
import { getState, openEditorFile, setUiError, useStore } from "../store.ts";
import type { SubagentState, TaskListState, ToolMsg } from "../reduce.ts";
import CopyButton from "./CopyButton.tsx";
import Dialog from "./a11y/Dialog.tsx";
import { Icon as ActionIcon, RedoIcon, UndoIcon } from "./ui/index.ts";

function ExecutionIcon({ kind }: { kind: ExecutionKind }) {
  const Glyph = kind === "shell" ? Icon.term
    : kind === "read" ? Icon.files
      : kind === "edit" || kind === "write" ? Icon.fileEdit
        : kind === "create" ? Icon.plus
          : kind === "delete" ? Icon.trash
            : kind === "move" ? Icon.branch
              : kind === "search" ? Icon.search
                : kind === "web" ? Icon.globe
                  : kind === "mcp" ? Icon.plug
                    : kind === "subagent" ? Icon.hierarchy
                      : kind === "test" ? Icon.check
                        : kind === "git" ? Icon.branch
                          : Icon.events;
  return <Glyph />;
}

type DisplayStatus = "pending" | "running" | "done" | "error" | "cancelled";
/** Matches the --motion-normal token so unmount waits for the CSS collapse. */
export const EXECUTION_COLLAPSE_MS = 180;

/** True when streamed text must not be animated: accessibility settings and
 *  the desktop low-resource mode both get the raw target directly. */
function motionSmoothOff(): boolean {
  if (document.body.dataset.desktopLowResource === "true") return true;
  if (document.documentElement.dataset.reduceAnimations === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Print-out effect for execution output: types the newest target text out
 *  from the current shown position (empty on first arrival), re-rated to a
 *  fixed ~300ms catch-up so live streaming reads as one continuous type-out
 *  while one-shot results print in. Shrinking targets (rewind) and reduced
 *  motion snap immediately. */
function usePrintText(target: string): string {
  const [shown, setShown] = useState("");
  const shownRef = useRef("");
  const raf = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    const targetLen = target.length;
    const shownLen = shownRef.current.length;
    if (targetLen < shownLen || motionSmoothOff()) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    if (shownLen >= targetLen) return;
    const rate = Math.max(4, Math.ceil((targetLen - shownLen) / 18));
    const step = () => {
      const behind = targetLen - shownRef.current.length;
      if (behind <= 0) return;
      const take = Math.min(behind, rate);
      shownRef.current = target.slice(0, shownRef.current.length + take);
      setShown(shownRef.current);
      if (shownRef.current.length < targetLen) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target]);
  return target.length < shown.length ? target : shown;
}

export function useCollapsePresence(open: boolean): boolean {
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!present) return;
    const timer = window.setTimeout(() => setPresent(false), EXECUTION_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [open, present]);
  return present;
}

function displayStatus(message: ToolMsg, childStatus?: string): DisplayStatus {
  if (childStatus && /^(?:queued|pending)$/i.test(childStatus)) return "pending";
  if (childStatus && /^(?:running|active|working)$/i.test(childStatus)) return "running";
  if (childStatus && /^(?:done|completed|success|succeeded)$/i.test(childStatus)) return "done";
  if (childStatus && /^(?:failed|error)$/i.test(childStatus)) return "error";
  if (message.status === "error" && /cancel(?:led|ed)|aborted|stopped/i.test(message.error ?? "")) return "cancelled";
  return message.status;
}

function StatusMark({ message, childStatus }: { message: ToolMsg; childStatus?: string }) {
  const [now, setNow] = useState(() => Date.now());
  const status = displayStatus(message, childStatus);
  useEffect(() => {
    if (status !== "pending" && status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [status]);
  const elapsed = fmtMs(Math.max(0, (message.finishTime ?? now) - message.time));
  const label = status === "pending" ? "Pending"
    : status === "running" ? "Running"
    : status === "error" ? "Failed"
      : status === "cancelled" ? "Cancelled"
        : "Succeeded";
  return (
    <span className={`execution-status ${status}`} aria-label={`${label} in ${elapsed}`}>
      <span className="execution-duration">{elapsed}</span>
      <span className="execution-status-icon" aria-hidden="true">
        {status === "pending" ? "○" : status === "running" ? <span className="ui-spinner ui-spinner--sm" /> : status === "done" ? "✓" : status === "error" ? "×" : "—"}
      </span>
    </span>
  );
}

function DetailHeading({ label, copy }: { label: string; copy?: string }) {
  return (
    <div className="execution-detail-heading">
      <span>{label}</span>
      {copy !== undefined && <CopyButton text={copy} label={`Copy ${label.toLowerCase()}`} />}
    </div>
  );
}

const TODO_MARK = { done: "✓", active: "●", failed: "×", pending: "○" } as const;

function TodoWritePreview({ items }: { items: TaskListState["items"] }) {
  const completed = items.filter((item) => item.status === "done").length;
  const open = useCollapsePresence(true);
  return (
    <section className="execution-todo-preview" aria-label="Todo list">
      <div className="execution-todo-count"><strong>Tasks</strong><span>{completed}/{items.length} complete</span></div>
      <div className="execution-todo-list-shell">
        <div className="execution-todo-list-content">
          {open && <ul>
            {items.map((item) => (
              <li key={item.id} className={item.status}>
                <span className="execution-todo-mark" aria-hidden="true">{TODO_MARK[item.status]}</span>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>}
        </div>
      </div>
    </section>
  );
}

function CommandDetail({ command }: { command: string }) {
  return (
    <section className="execution-detail-section">
      <DetailHeading label="Command" copy={command} />
      <pre className="execution-command" tabIndex={0}>{command}</pre>
    </section>
  );
}

export function hasLineChanges(stats?: { add: number; del: number }): stats is { add: number; del: number } {
  return stats !== undefined && (stats.add > 0 || stats.del > 0);
}

export function DiffStat({ add, del }: { add: number; del: number }) {
  const label = `${add === 1 ? "1 line added" : `${add} lines added`}, ${
    del === 1 ? "1 line removed" : `${del} lines removed`
  }`;
  return (
    <span className="execution-diff-stat" aria-label={label}>
      {add > 0 && <span className="positive">+{add}</span>}
      {del > 0 && <span className="negative">−{del}</span>}
    </span>
  );
}

function diffLineClass(kind: string): string {
  if (kind === "add") return "diff-add";
  if (kind === "del") return "diff-del";
  if (kind === "hunk") return "diff-hunk";
  return "";
}

function DiffLines({ diff, path, limit }: { diff: string; path: string; limit?: number }) {
  const rows = visibleDiffRows(diff);
  const shown = limit === undefined ? rows : rows.slice(0, limit);
  const lang = langOf(path);
  return (
    <div className="git-diff" role="table" aria-label={`Changes in ${path}`}>
      {shown.map((row, index) => {
        const shownLn = row.kind === "del" ? row.oldLine : row.newLine;
        const lineLabel = row.kind === "del" && row.oldLine !== undefined
          ? `removed line ${row.oldLine}`
          : row.newLine !== undefined ? `line ${row.newLine}` : "diff metadata";
        return (
          <div key={`${index}:${row.text}`} className={`git-diff-line ${diffLineClass(row.kind)}`} role="row" aria-label={lineLabel}>
            <span className="git-diff-ln" aria-hidden="true">{shownLn ?? ""}</span>
            <span dangerouslySetInnerHTML={{ __html: highlight(row.text, lang) }} />
          </div>
        );
      })}
    </div>
  );
}

function applyFailureMessage(reason: string, direction: DiffApplyDirection): string {
  if (reason === "already-reverted") return "These changes are already reverted";
  if (reason === "already-applied") return "This file already matches the edit";
  if (reason === "empty") return "This change has no file content to apply";
  return direction === "reverse"
    ? "The file has changed; these edits can no longer be reverted"
    : "The file has changed; these edits can no longer be redone";
}

async function applyFileDiffOnDisk(file: FileDiff, direction: DiffApplyDirection): Promise<void> {
  const projectId = getState().activeProjectId;
  const sessionId = getState().activeSessionId ?? undefined;
  if (!projectId) throw new Error("No project is active");
  let current: string | null = null;
  let revision: string | undefined;
  try {
    const read = await api.filesRead(projectId, file.path, sessionId);
    if (read.tooLarge || read.truncated) {
      throw new Error(direction === "reverse"
        ? "File is too large to revert safely"
        : "File is too large to redo safely");
    }
    current = read.content;
    revision = read.revision;
  } catch (error) {
    const missing = httpStatusOf(error) === 404
      || errorCodeOf(error) === "not-found"
      || /ENOENT|no such file/i.test(error instanceof Error ? error.message : "");
    if (!missing) throw error;
  }
  const result = applyUnifiedDiff(current, file.diff, direction);
  if (!result.ok) throw new Error(applyFailureMessage(result.reason, direction));
  if (result.action === "delete") {
    await api.filesDelete(projectId, file.path, sessionId);
    return;
  }
  await api.filesWrite(projectId, file.path, result.content, revision, sessionId);
}

function FileDiffActions({
  file,
  long,
  reverted,
  onReverted,
  onOpenFile,
  onOpenFull,
}: {
  file: FileDiff;
  long: boolean;
  reverted: boolean;
  onReverted: (next: boolean) => void;
  onOpenFile: (path: string) => void;
  onOpenFull: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const direction: DiffApplyDirection = reverted ? "forward" : "reverse";
  const apply = () => {
    if (busy) return;
    setBusy(true);
    void applyFileDiffOnDisk(file, direction)
      .then(() => onReverted(direction === "reverse"))
      .catch((error) => setUiError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  const label = busy
    ? (reverted ? "Redoing…" : "Reverting…")
    : reverted ? "Redo" : "Revert changes";
  return (
    <div className="execution-file-actions">
      <button type="button" onClick={apply} disabled={busy} aria-busy={busy || undefined}>
        <ActionIcon icon={reverted ? RedoIcon : UndoIcon} size="sm" />
        {label}
      </button>
      <div className="execution-file-actions-end">
        {file.status !== "deleted" && (
          <button type="button" onClick={() => onOpenFile(file.path)}>Open in Files</button>
        )}
        {long && <button type="button" onClick={onOpenFull}>View full diff</button>}
        <CopyButton text={file.diff} label="Copy diff" />
      </div>
    </div>
  );
}

function FileDiffBody({
  file,
  labeled,
  defaultOpen,
  reverted,
  onReverted,
  onOpenFile,
  onOpenFull,
}: {
  file: FileDiff;
  labeled: boolean;
  defaultOpen: boolean;
  reverted: boolean;
  onReverted: (next: boolean) => void;
  onOpenFile: (path: string) => void;
  onOpenFull: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const rows = visibleDiffRows(file.diff);
  const long = rows.length > 120;
  const showDiff = !labeled || open;
  return (
    <article className="execution-file-change">
      {labeled && (
        <button
          type="button"
          className="execution-file-toggle"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${file.path}, ${file.stats.add} added, ${file.stats.del} removed`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="execution-file-path" title={file.path}>
            {file.previousPath && <span className="muted">{file.previousPath} → </span>}
            {file.path}
          </span>
          {hasLineChanges(file.stats) ? <DiffStat add={file.stats.add} del={file.stats.del} /> : null}
          <span className="tool-chevron" aria-hidden="true">{open ? <Icon.chevronUp /> : <Icon.chevronRight />}</span>
        </button>
      )}
      {showDiff && (rows.length === 0
        ? <p className="muted">No textual changes</p>
        : <DiffLines diff={file.diff} path={file.path} limit={long ? 120 : undefined} />)}
      {showDiff && (
        <FileDiffActions
          file={file}
          long={long}
          reverted={reverted}
          onReverted={onReverted}
          onOpenFile={onOpenFile}
          onOpenFull={onOpenFull}
        />
      )}
    </article>
  );
}

function FileChangesView({
  files,
  revertedPaths,
  onReverted,
  onOpenFile,
  onOpenFull,
}: {
  files: readonly FileDiff[];
  revertedPaths: ReadonlySet<string>;
  onReverted: (path: string, next: boolean) => void;
  onOpenFile: (path: string) => void;
  onOpenFull: (file: FileDiff) => void;
}) {
  const labeled = files.length > 1;
  const expandByDefault = files.length <= 4;
  return (
    <section className="execution-detail-section execution-file-changes" aria-label="File changes">
      {files.map((file, index) => (
        <FileDiffBody
          key={`${file.path}:${index}`}
          file={file}
          labeled={labeled}
          defaultOpen={expandByDefault}
          reverted={revertedPaths.has(file.path)}
          onReverted={(next) => onReverted(file.path, next)}
          onOpenFile={onOpenFile}
          onOpenFull={() => onOpenFull(file)}
        />
      ))}
    </section>
  );
}

function OutputPreview({ text, error = false, onOpenFull }: {
  text: string;
  error?: boolean;
  onOpenFull: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const printed = usePrintText(text);
  const lines = outputLineCount(text);
  const long = lines > 12 || text.length > 1600;
  const shown = showAll ? printed : printed.split(/\r?\n/).slice(0, 12).join("\n");
  return (
    <section className={`execution-detail-section execution-result${error ? " error" : ""}`}>
      <DetailHeading label={error ? "Error" : "Output"} copy={text} />
      <pre className={showAll ? "execution-output expanded" : "execution-output"} tabIndex={0}>{shown || "No output"}</pre>
      {long && (
        <div className="execution-output-actions">
          <button type="button" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Collapse output" : `Show all ${lines} lines`}
          </button>
          <button type="button" onClick={onOpenFull}>Open full output</button>
        </div>
      )}
    </section>
  );
}

function SearchResults({ text, onOpenFull }: { text: string; onOpenFull: () => void }) {
  const results = text.split(/\r?\n/).filter(Boolean).slice(0, 8).map((line) => {
    const match = line.match(/^(.+?):(\d+)(?::(.*))?$/);
    return match
      ? { raw: line, path: match[1]!, line: Number(match[2]), context: match[3]?.trim() ?? "" }
      : { raw: line };
  });
  return (
    <section className="execution-detail-section execution-search-results">
      <DetailHeading label="Results" copy={text} />
      <div className="execution-search-list">
        {results.map((result, index) => (
          result.path ? (
            <button
              type="button"
              key={`${index}:${result.raw}`}
              onClick={() => openEditorFile(result.path ?? null, { path: result.path!, startLine: result.line })}
            >
              <span><code>{result.path}</code><small>:{result.line}</small></span>
              {result.context && <span>{result.context}</span>}
            </button>
          ) : <div key={`${index}:${result.raw}`}><code>{result.raw}</code></div>
        ))}
      </div>
      {outputLineCount(text) > results.length && (
        <div className="execution-output-actions">
          <button type="button" onClick={onOpenFull}>Open all {outputLineCount(text)} results</button>
        </div>
      )}
    </section>
  );
}

function McpResult({ output }: { output: string }) {
  const entries = normalizedMcpResult(output);
  if (entries === null) {
    return (
      <section className="execution-detail-section execution-mcp-result">
        <DetailHeading label="Result" copy={output} />
        <p>{output.replace(/\s+/g, " ").trim() || "No result"}</p>
      </section>
    );
  }
  return (
    <section className="execution-detail-section execution-mcp-result">
      <DetailHeading label="Result" />
      {entries.length > 0 ? (
        <dl>
          {entries.map((entry) => (
            <div key={entry.key}>
              <dt>{entry.key}</dt>
              <dd>{entry.href
                ? <a href={entry.href} target="_blank" rel="noreferrer">{entry.value} <Icon.external /></a>
                : entry.value}</dd>
            </div>
          ))}
        </dl>
      ) : <p>Structured result available</p>}
    </section>
  );
}

type Subagent = SubagentState["agents"][number];

function SubagentWork({ sessionId, status }: { sessionId: string; status: string }) {
  const [events, setEvents] = useState<Array<{ seq: number; type: string; data: Record<string, unknown> }>>([]);
  const [steering, setSteering] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const running = /^(?:running|active|working)$/i.test(status);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void api.getEvents(sessionId).then((next) => {
        if (alive) setEvents(next as typeof events);
      }).catch(() => {});
    };
    load();
    const timer = running ? setInterval(load, 1_500) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [sessionId, running]);

  const activity = events.filter((event) =>
    event.type === "user/message" || event.type === "assistant/message" || event.type === "assistant/chunk" || event.type === "tool/call",
  ).slice(-8);
  const steer = () => {
    const text = steering.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    void api.sendMessage(sessionId, { text, delivery: "steer" })
      .then(() => setSteering(""))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSending(false));
  };
  return (
    <div className="execution-subagent-work" aria-label="Subagent work and steering">
      <div className="execution-subagent-activity">
        {activity.length === 0 ? <span>Waiting for subagent activity…</span> : activity.map((event) => {
          const data = event.data;
          const text = typeof data.text === "string" ? data.text
            : typeof data.output === "string" ? data.output
              : typeof data.tool === "string" ? data.tool : event.type;
          return <p key={event.seq}><b>{event.type.startsWith("assistant") ? "Agent" : event.type.startsWith("user") ? "You" : "Tool"}</b>{text}</p>;
        })}
      </div>
      <div className="execution-subagent-steer">
        <textarea
          value={steering}
          onChange={(event) => setSteering(event.target.value)}
          placeholder="Steer this subagent…"
          aria-label="Steer subagent"
          onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") steer(); }}
        />
        <button type="button" onClick={steer} disabled={!steering.trim() || sending}>{sending ? "Sending…" : "Steer"}</button>
      </div>
      {error && <p className="execution-subagent-error" role="alert">{error}</p>}
    </div>
  );
}

function childSessionStatus(
  subagentStatus: string,
  childSession: SessionProjection | undefined,
): string {
  if (/^(?:done|completed|success|succeeded|failed|error|cancelled|canceled|stopped|aborted)$/i.test(subagentStatus)) {
    return subagentStatus;
  }
  if (childSession && !["working", "waiting", "reconciling", "unknown", "epoch-pending"].includes(childSession.status)) {
    return childSession.status;
  }
  return subagentStatus;
}

function SubagentDetail({ subagent }: { subagent: Subagent }) {
  const sessions = useStore((state) => state.sessions);
  const activeSessionId = useStore((state) => state.activeSessionId);
  const models = useStore((state) => state.models);
  const childSession = sessions.find((session) => session.id === subagent.sessionId);
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const parentSession = childSession?.parentId
    ? sessions.find((session) => session.id === childSession.parentId) ?? activeSession
    : activeSession;
  const model = childSession?.model ?? parentSession?.model;
  const descriptor = model
    ? models.find((candidate) =>
        candidate.providerID === model.providerID && candidate.modelID === model.modelID)
    : undefined;
  const modelLabel = descriptor?.name
    ?? (model ? `${model.providerID}/${model.modelID}` : "Unknown model");
  const inheritedModel = childSession?.model === undefined;
  const parentLabel = parentSession?.title ?? "Current session";
  const openChild = () => {
    void openSession(subagent.sessionId).catch((error) =>
      setUiError(error instanceof Error ? error.message : String(error)));
  };
  const effectiveSubagentStatus = childSessionStatus(subagent.status, childSession);
  const status = /^(?:done|completed|success|succeeded|stopped|aborted|cancelled|canceled)$/i.test(effectiveSubagentStatus)
    ? "Completed"
    : /^(?:failed|error)$/i.test(effectiveSubagentStatus)
      ? "Failed"
      : /^(?:queued|pending)$/i.test(effectiveSubagentStatus)
        ? "Pending"
        : "Running";
  return (
    <section className="execution-detail-section execution-subagent-detail" aria-label={`Child agent ${subagent.label}`}>
      <span className="execution-subagent-branch" aria-hidden="true"><Icon.hierarchy /></span>
      <div>
        <strong>{subagent.label}</strong>
        <span className={`execution-subagent-state ${status.toLowerCase()}`}>{status}</span>
        {subagent.currentTask && <p>{subagent.currentTask}</p>}
        <dl className="execution-subagent-meta">
          <div><dt>Model</dt><dd>{modelLabel}{inheritedModel ? " · inherited" : ""}</dd></div>
          <div><dt>Parent</dt><dd>{parentLabel}</dd></div>
        </dl>
        {childSession && <SubagentWork sessionId={childSession.id} status={effectiveSubagentStatus} />}
      </div>
      <button type="button" onClick={openChild}>Open child session <Icon.external /></button>
    </section>
  );
}

interface TimelineScrollAnchor {
  element: HTMLElement;
  scrollTop: number;
}

function FullOutputViewer({ title, text, mode = "text", scrollAnchor, restoreTarget, onClose }: {
  title: string;
  text: string;
  mode?: "text" | "diff";
  scrollAnchor?: TimelineScrollAnchor;
  restoreTarget?: HTMLElement;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(true);
  const filtered = useMemo(() => {
    if (!query.trim()) return text;
    const needle = query.toLowerCase();
    return text.split(/\r?\n/).filter((line) => line.toLowerCase().includes(needle)).join("\n");
  }, [query, text]);
  const viewer = (
    <Dialog
      title={title}
      onClose={onClose}
      size="full"
      initialFocus='input[type="search"]'
      className="execution-viewer"
      backdropClassName="execution-viewer-backdrop"
      resolveRestoreFocus={() => null}
      onAfterRestoreFocus={() => {
        if (restoreTarget?.isConnected) restoreTarget.focus({ preventScroll: true });
        if (!scrollAnchor) return;
        const restore = () => {
          if (scrollAnchor.element.isConnected) scrollAnchor.element.scrollTop = scrollAnchor.scrollTop;
        };
        // Chromium may defer the opener's focus scroll until the next frame.
        // Reapply once after that scroll and once after the resulting layout.
        requestAnimationFrame(() => {
          restore();
          requestAnimationFrame(restore);
        });
      }}
    >
      <header>
        <strong>{title}</strong>
        <span>{outputLineCount(text)} lines</span>
        <CopyButton text={text} label="Copy full output" />
        <button type="button" className="execution-viewer-close" onClick={onClose} aria-label={`Close ${title}`}><Icon.close /></button>
      </header>
      <div className="execution-viewer-tools">
        <label><Icon.search /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search output" /></label>
        <button type="button" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>Wrap {wrap ? "on" : "off"}</button>
      </div>
      {mode === "diff"
        ? <div className={wrap ? "execution-viewer-diff wrap" : "execution-viewer-diff"}><DiffLines diff={filtered} path={title} /></div>
        : <pre className={wrap ? "wrap" : ""}>{filtered || "No matching lines"}</pre>}
    </Dialog>
  );
  return createPortal(viewer, document.body);
}

function metadataValue(metadata: JsonObject | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return undefined;
}

const PATH_DETAIL_KEYS = new Set(["filepath", "file path", "path", "file", "target"]);

function isPathDetailKey(key: string): boolean {
  return PATH_DETAIL_KEYS.has(key.replace(/_/g, " ").toLowerCase());
}

function isTrivialFileEditOutput(output: string | undefined, hasDiff: boolean): boolean {
  if (!hasDiff) return false;
  const text = (output ?? "").trim();
  if (text === "") return true;
  if (/success\.?\s*(?:updated|modified)\s+the following files?:/i.test(text.replace(/^>\s*/gm, ""))) return true;
  if (/[\r\n]/.test(text) || text.length > 48) return false;
  return !/error|fail|denied/i.test(text);
}

export function ExecutionRow({
  message,
  subagent,
}: {
  message: ToolMsg;
  subagent?: Subagent;
}) {
  const status = displayStatus(message, subagent?.status);
  // Always folded by default — even while running or in the active turn. The
  // reader opens a row by hand; nothing auto-expands (same contract as
  // WorkedGroup).
  const [open, setOpen] = useState(false);
  const [revertedPaths, setRevertedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const detailsPresent = useCollapsePresence(open);
  const rowRef = useRef<HTMLDivElement>(null);
  const pointerScrollAnchor = useRef<(TimelineScrollAnchor & { capturedAt: number }) | null>(null);
  const [viewer, setViewer] = useState<{
    title: string;
    text: string;
    mode?: "text" | "diff";
    scrollAnchor?: TimelineScrollAnchor;
    restoreTarget?: HTMLElement;
  } | null>(null);
  // Tool messages mutate in place; `rev` bumps on every mutation, so these
  // derivations (JSON.stringify of potentially large outputs) run once per
  // actual change instead of on every parent render.
  const presentation = useMemo(() => executionPresentation(message), [message, message.rev]);
  const todoItems = useMemo(() => {
    if (!/^(?:todowrite|todo)$/i.test(message.tool)) return undefined;
    const value = message.input.todos;
    return Array.isArray(value) ? value.filter((item): item is TaskListState["items"][number] => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Record<string, unknown>;
      return typeof candidate.id === "string" && (typeof candidate.content === "string" || typeof candidate.text === "string") &&
        (candidate.status === "pending" || candidate.status === "active" || candidate.status === "done" || candidate.status === "failed");
    }).map((item) => ({ id: item.id, text: item.text, status: item.status })) : undefined;
  }, [message, message.rev]);
  const inputEntries = useMemo(() => {
    const entries = normalizedInputEntries(message.input);
    return presentation.files?.length
      ? entries.filter((entry) => !isPathDetailKey(entry.key))
      : entries;
  }, [message, message.rev, presentation.files]);
  const inputJson = useMemo(() => JSON.stringify(message.input, null, 2), [message, message.rev]);
  const raw = useMemo(() => JSON.stringify({
    tool: message.tool,
    input: message.input,
    ...(message.output !== undefined ? { output: message.output } : {}),
    ...(message.error !== undefined ? { error: message.error } : {}),
    ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
  }, null, 2), [message, message.rev]);
  const exitCode = metadataValue(message.metadata, ["exit", "exitCode", "exit_code"]);
  const cwd = metadataValue(message.metadata, ["cwd"])
    ?? (typeof message.input.cwd === "string" ? message.input.cwd : undefined);
  const stats = presentation.stats;
  const elapsed = fmtMs(Math.max(0, (message.finishTime ?? Date.now()) - message.time));
  const webUrl = typeof message.input.url === "string" ? message.input.url : undefined;
  // The collapsed summary prints out on appearance (and types new arrivals
  // while a call streams) — same fast catch-up type-out the output uses.
  const typedPreview = usePrintText(presentation.preview);

  const openFile = () => {
    if (presentation.path) openEditorFile(presentation.path);
  };
  const openViewer = (title: string, text: string, mode: "text" | "diff" = "text") => {
    const timeline = rowRef.current?.closest<HTMLElement>(".timeline");
    const pointerAnchor = pointerScrollAnchor.current;
    pointerScrollAnchor.current = null;
    const scrollAnchor = pointerAnchor && Date.now() - pointerAnchor.capturedAt < 1_000
      ? { element: pointerAnchor.element, scrollTop: pointerAnchor.scrollTop }
      : timeline
        ? { element: timeline, scrollTop: timeline.scrollTop }
        : undefined;
    const restoreTarget = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    setViewer({
      title,
      text,
      mode,
      ...(scrollAnchor ? { scrollAnchor } : {}),
      ...(restoreTarget ? { restoreTarget } : {}),
    });
  };

  return (
    <>
      <div className={`tool-card execution-row${open ? " open" : ""}${status === "pending" || status === "running" ? " current" : ""}${status === "error" ? " error" : ""}${presentation.kind === "subagent" ? " execution-subagent" : ""}`}
        ref={rowRef}
        data-execution-kind={presentation.kind}
        onPointerDownCapture={() => {
          const timeline = rowRef.current?.closest<HTMLElement>(".timeline");
          pointerScrollAnchor.current = timeline
            ? { element: timeline, scrollTop: timeline.scrollTop, capturedAt: Date.now() }
            : null;
        }}
      >
        <button
          type="button"
          className="tool-disclosure execution-summary"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${presentation.label}: ${presentation.preview}${
            hasLineChanges(stats) ? `, ${stats.add} added, ${stats.del} removed` : ""
          }`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="tool-icon execution-icon" aria-hidden="true"><ExecutionIcon kind={presentation.kind} /></span>
          <span className="execution-main">
            <span className="tool-name">{presentation.label}</span>
            <span className={`tool-preview${presentation.kind === "shell" || presentation.kind === "test" ? " command" : ""}`}>{typedPreview}</span>
          </span>
          <span className="execution-diff-stat-slot">{hasLineChanges(stats) ? <DiffStat add={stats.add} del={stats.del} /> : null}</span>
          <StatusMark message={message} childStatus={subagent?.status} />
          <span className="tool-chevron" aria-hidden="true">{open ? <Icon.chevronUp /> : <Icon.chevronRight />}</span>
        </button>
        <div className="execution-expand-shell" aria-hidden={!open}>
          <div className="execution-collapse-content">
          {detailsPresent && (
            <div className="tool-body execution-details">
              {presentation.command && <CommandDetail command={presentation.command} />}
              {subagent && <SubagentDetail subagent={subagent} />}
              {presentation.path && !presentation.files?.length && (
                <section className="execution-detail-section execution-file-summary">
                  <DetailHeading label="File" copy={presentation.path} />
                  <code>{presentation.path}</code>
                  <div className="execution-inline-actions">
                    <button type="button" onClick={openFile}>Open in Files</button>
                    <button type="button" onClick={openFile}>View full file</button>
                  </div>
                </section>
              )}
              {presentation.files && presentation.files.length > 0 && (
                <FileChangesView
                  files={presentation.files}
                  revertedPaths={revertedPaths}
                  onReverted={(path, next) => {
                    setRevertedPaths((prev) => {
                      const nextSet = new Set(prev);
                      if (next) nextSet.add(path);
                      else nextSet.delete(path);
                      return nextSet;
                    });
                  }}
                  onOpenFile={(path) => openEditorFile(path)}
                  onOpenFull={(file) => openViewer(`${presentation.label} ${file.path}`, file.diff, "diff")}
                />
              )}
              {todoItems && todoItems.length > 0 ? <TodoWritePreview items={todoItems} /> : inputEntries.length > 0 && (
                <section className="execution-detail-section execution-input">
                  <DetailHeading label="Details" />
                  <dl>
                    {inputEntries.map(({ key, value }) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
                  </dl>
                </section>
              )}
              {message.error !== undefined && (
                <OutputPreview text={message.error} error onOpenFull={() => openViewer(`${presentation.label} error`, message.error ?? "")} />
              )}
              {message.output !== undefined && !isTrivialFileEditOutput(message.output, Boolean(presentation.files?.length)) && (
                presentation.kind === "search"
                  ? <SearchResults text={message.output} onOpenFull={() => openViewer(`${presentation.label} results`, message.output ?? "")} />
                  : presentation.kind === "mcp"
                    ? <McpResult output={message.output} />
                  : <OutputPreview text={message.output} onOpenFull={() => openViewer(`${presentation.label} output`, message.output ?? "")} />
              )}
              {!presentation.files?.length && (
                <footer className="execution-metadata">
                  {exitCode !== undefined && <span>Exit code {exitCode}</span>}
                  <span>{elapsed}</span>
                  {cwd && <span>cwd {cwd}</span>}
                  {presentation.kind === "mcp" && <code className="execution-tool-id">{message.tool}</code>}
                  {webUrl && <a href={webUrl} target="_blank" rel="noreferrer">Open link <Icon.external /></a>}
                  <button type="button" onClick={() => openViewer(`${presentation.label} raw result`, raw)}>View raw result</button>
                  {!presentation.command && inputJson !== "{}" && <CopyButton text={inputJson} label="Copy tool input" />}
                </footer>
              )}
            </div>
          )}
          </div>
        </div>
      </div>
      {viewer && <FullOutputViewer title={viewer.title} text={viewer.text} mode={viewer.mode} scrollAnchor={viewer.scrollAnchor} restoreTarget={viewer.restoreTarget} onClose={() => setViewer(null)} />}
    </>
  );
}

export default ExecutionRow;
