import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JsonObject, SessionProjection } from "@polyth/contracts";
import { resolveModelPresentation } from "@polyth/models/presentation";
import { api, errorCodeOf, httpStatusOf } from "@polyth/session/web-api";
import { fmtMs } from "../format.ts";
import {
  executionPresentation,
  executionPathParts,
  isImagePath,
  normalizedMcpResult,
  normalizedInputEntries,
  outputLineCount,
  readFragment,
  type ExecutionKind,
} from "../execution.ts";
import { applyUnifiedDiff, visibleDiffRows, type DiffApplyDirection, type FileDiff } from "../diff.ts";
import { highlight, highlightLines, langOf } from "../highlight.ts";
import { tr } from "../i18n/index.ts";
import { Icon } from "../icons.tsx";
import { openSession } from "../init.ts";
import { getState, openEditorFile, setUiError, useStore } from "../store.ts";
import type { SubagentState, TaskListState, ToolMsg } from "../reduce.ts";
import AttachmentPreview from "./AttachmentPreview.tsx";
import CopyButton from "./CopyButton.tsx";
import Dialog from "./a11y/Dialog.tsx";
import { Button, Icon as ActionIcon, RedoIcon, StopIcon, Textarea, UndoIcon } from "./ui/index.ts";

function ExecutionIcon({ kind, image = false }: { kind: ExecutionKind; image?: boolean }) {
  const Glyph = image ? Icon.image
    : kind === "shell" ? Icon.term
    : kind === "read" ? Icon.files
      : kind === "edit" || kind === "write" ? Icon.fileEdit
        : kind === "create" ? Icon.plus
          : kind === "delete" ? Icon.trash
            : kind === "move" ? Icon.branch
              : kind === "search" ? Icon.search
                : kind === "web" || kind === "browser" ? Icon.globe
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
  if (typeof document !== "undefined" && document.body.dataset.desktopLowResource === "true") return true;
  if (typeof document !== "undefined" && document.documentElement.dataset.reduceAnimations === "true") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Print-out effect for execution output: types the newest target text out
 *  from the current shown position (empty on first arrival), re-rated to a
 *  fixed ~300ms catch-up so live streaming reads as one continuous type-out
 *  while one-shot results print in. Shrinking targets (rewind) and reduced
 *  motion snap immediately. */
function usePrintText(target: string, animate = true): string {
  const initial = animate && !motionSmoothOff() ? "" : target;
  const [shown, setShown] = useState(initial);
  const shownRef = useRef(initial);
  const raf = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    const targetLen = target.length;
    const shownLen = shownRef.current.length;
    if (!animate || targetLen < shownLen || motionSmoothOff()) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    if (shownLen >= targetLen) return;
    const rate = Math.max(4, Math.ceil((targetLen - shownLen) / 18));
    const step = () => {
      if (motionSmoothOff()) {
        shownRef.current = target;
        setShown(target);
        return;
      }
      const behind = targetLen - shownRef.current.length;
      if (behind <= 0) return;
      const take = Math.min(behind, rate);
      shownRef.current = target.slice(0, shownRef.current.length + take);
      setShown(shownRef.current);
      if (shownRef.current.length < targetLen) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, animate]);
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
  if (message.status === "error" && /cancel(?:led|ed)|aborted|stopped|interrupted/i.test(message.error ?? "")) return "cancelled";
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
      <pre className="execution-command" tabIndex={0}>
        <code dangerouslySetInnerHTML={{ __html: highlight(command, "sh") }} />
      </pre>
    </section>
  );
}

/** The file the action worked on, presented as the file itself: name first,
 *  location second, one click into the editor. */
function FileTarget({ path, parts, onOpen }: {
  path: string;
  parts?: { filename: string; directory: string };
  onOpen: () => void;
}) {
  return (
    <section className="execution-detail-section execution-file-summary" aria-label="File">
      <button type="button" className="execution-file-open" onClick={onOpen} title={path}>
        <span className="execution-file-open-icon" aria-hidden="true"><Icon.fileEdit /></span>
        <span className="execution-file-open-name">
          <strong>{parts?.filename ?? path}</strong>
          {parts?.directory && <span>{parts.directory}</span>}
        </span>
        <span className="execution-file-open-hint">Open in editor</span>
        <span className="execution-file-open-chevron" aria-hidden="true"><Icon.chevronRight /></span>
      </button>
      <CopyButton text={path} label="Copy file path" />
    </section>
  );
}

/** An image the agent looked at is shown as the image, not as a path plus a
 *  base64 blob. Clicking it opens the same full-screen viewer attachments use. */
function ImageDetail({ path, name }: { path: string; name: string }) {
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const [open, setOpen] = useState(false);
  const url = projectId ? api.filesRawUrl(projectId, path, sessionId ?? undefined) : undefined;
  if (!url) return null;
  return (
    <section className="execution-detail-section execution-image" aria-label="Image">
      <button type="button" className="execution-image-open" onClick={() => setOpen(true)} title={path}>
        <img src={url} alt={name} loading="lazy" />
        <span className="execution-image-caption">
          <span className="execution-image-icon" aria-hidden="true"><Icon.image /></span>
          <strong>{name}</strong>
          <span>View image</span>
        </span>
      </button>
      {open && (
        <AttachmentPreview
          attachments={[{ id: path, name, mime: "image/*", size: 0, kind: "image", path, url }]}
          start={0}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

const FRAGMENT_PREVIEW_LINES = 14;

/** Read output rendered as what it is — source, with a real gutter and the
 *  file's own syntax colour. */
function CodeFragment({ text, path, onOpenFull }: {
  text: string;
  path?: string;
  onOpenFull: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const { code, startLine } = useMemo(() => readFragment(text), [text]);
  const lines = useMemo(() => highlightLines(code, langOf(path ?? "")), [code, path]);
  const shown = showAll ? lines : lines.slice(0, FRAGMENT_PREVIEW_LINES);
  return (
    <section className="execution-detail-section">
      <DetailHeading label="Contents" copy={code} />
      <div className={`execution-code${showAll ? " expanded" : ""}`} tabIndex={0} role="group" aria-label={`Contents of ${path ?? "file"}`}>
        {shown.map((line, index) => (
          <div key={startLine + index} className="execution-code-line">
            <span className="execution-code-ln" aria-hidden="true">{startLine + index}</span>
            <span dangerouslySetInnerHTML={{ __html: line || " " }} />
          </div>
        ))}
      </div>
      {lines.length > FRAGMENT_PREVIEW_LINES && (
        <div className="execution-output-actions">
          <button type="button" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Collapse" : `Show all ${lines.length} lines`}
          </button>
          <button type="button" onClick={onOpenFull}>Open full output</button>
        </div>
      )}
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

function OutputPreview({ text, error = false, animate = false, onOpenFull }: {
  text: string;
  error?: boolean;
  animate?: boolean;
  onOpenFull: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const printed = usePrintText(text, animate);
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

type SubagentEvent = { seq: number; type: string; data: Record<string, unknown> };
type TrailEntry = { seq: number; role: "you" | "agent" | "tool"; text: string };

const TRAIL_ROLE = { you: "You", agent: "Agent", tool: "Tool" } as const;

/** Humanise a raw tool id ("read", "mcp__github__get_pull_request") into a
 *  short activity label. */
function toolLabel(tool: string): string {
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
  const words = (mcp ? `${mcp[1]} ${mcp[2]}` : tool).replace(/[_-]+/g, " ").trim();
  return words ? words.replace(/\b\w/g, (char) => char.toUpperCase()) : "Tool";
}

/** Fold the raw child event stream into a short readable trail: one row per
 *  message or tool call, streaming chunks merged back into their message,
 *  empty reasoning-only turns dropped, newest last. */
function activityTrail(events: readonly SubagentEvent[]): TrailEntry[] {
  type Row = TrailEntry & { partId?: string; callId?: string };
  const rows: Row[] = [];
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  for (const { seq, type, data } of events) {
    if (type === "user/message") {
      const text = str(data.text).trim();
      if (text) rows.push({ seq, role: "you", text });
    } else if (type === "assistant/chunk" || type === "assistant/message") {
      const partId = str(data.partId) || undefined;
      const delta = str(data.text);
      const prior = partId ? rows.find((row) => row.partId === partId) : undefined;
      if (prior) {
        prior.text = type === "assistant/message" ? (delta.trim() || prior.text) : (prior.text + delta).trimStart();
        prior.seq = seq;
      } else {
        rows.push({ seq, role: "agent", text: delta.trimStart(), partId });
      }
    } else if (type === "tool/call") {
      const callId = str(data.callId) || undefined;
      const prior = callId ? rows.find((row) => row.callId === callId) : undefined;
      if (prior) prior.seq = seq;
      else rows.push({ seq, role: "tool", text: toolLabel(str(data.tool)), callId });
    }
  }
  return rows
    .filter((row) => row.text.trim())
    .map(({ seq, role, text }) => ({ seq, role, text: text.replace(/\s+/g, " ").trim() }))
    .slice(-6);
}

function SubagentWork({ sessionId, status }: { sessionId: string; status: string }) {
  const [events, setEvents] = useState<SubagentEvent[]>([]);
  const [steering, setSteering] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const running = /^(?:running|active|working)$/i.test(status);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void api.getEvents(sessionId).then((next) => {
        if (alive) setEvents(next as SubagentEvent[]);
      }).catch(() => {});
    };
    load();
    const timer = running ? setInterval(load, 1_500) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [sessionId, running]);

  const trail = useMemo(() => activityTrail(events), [events]);
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
      <ol className="execution-subagent-trail">
        {trail.length === 0
          ? <li className="execution-subagent-trail-empty">Waiting for subagent activity…</li>
          : trail.map((entry) => (
            <li key={entry.seq} data-role={entry.role}>
              <span className="execution-subagent-trail-role">{TRAIL_ROLE[entry.role]}</span>
              <span className="execution-subagent-trail-text">{entry.text}</span>
            </li>
          ))}
      </ol>
      <form className="execution-subagent-steer" onSubmit={(event) => { event.preventDefault(); steer(); }}>
        <Textarea
          value={steering}
          onChange={(event) => setSteering(event.target.value)}
          placeholder="Steer this subagent…"
          aria-label="Steer subagent"
          autoGrow
          minRows={1}
          maxRows={4}
          onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") steer(); }}
        />
        <Button type="submit" size="sm" variant="primary" busy={sending} disabled={!steering.trim()}>Steer</Button>
      </form>
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
  // The runtime snapshot can briefly expose OpenCode's backend id before the
  // server publishes the canonical Polyth projection. Match both ids so the
  // action does not become a permanently disabled "Syncing" button.
  const childSession = sessions.find((session) =>
    session.id === subagent.sessionId || session.backendSessionId === subagent.sessionId,
  );
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const parentSession = childSession?.parentId
    ? sessions.find((session) => session.id === childSession.parentId) ?? activeSession
    : activeSession;
  const model = childSession?.model ?? parentSession?.model;
  const harnessId = childSession?.resolvedHarnessId ?? parentSession?.resolvedHarnessId;
  const modelLabel = model ? resolveModelPresentation(model, models, harnessId).name : "Auto";
  const inheritedModel = childSession?.model === undefined;
  const parentLabel = parentSession?.title ?? "Current session";
  const openChild = () => {
    void openSession(childSession?.id ?? subagent.sessionId).catch((error) =>
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
        {childSession && (
          <details className="execution-subagent-disclosure" open={status === "Running"}>
            <summary>Live activity <span>· steer agent</span></summary>
            <SubagentWork sessionId={childSession.id} status={effectiveSubagentStatus} />
          </details>
        )}
      </div>
      <button type="button" onClick={openChild}>
        Open child session <Icon.external />
      </button>
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
  entering = false,
}: {
  message: ToolMsg;
  subagent?: Subagent;
  /** Only the newest visible execution gets entrance and print-out motion. */
  entering?: boolean;
}) {
  const status = displayStatus(message, subagent?.status);
  const sessionId = useStore((state) => state.activeSessionId);
  const toolActive = useStore((state) => {
    const events = state.activeSessionId ? state.events[state.activeSessionId] : undefined;
    for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
      const event = events![index]!;
      if (event.type === "turn/stopped" || event.type === "turn/started") return false;
      const callId = (event.data as { callId?: unknown }).callId;
      if (callId !== message.callId) continue;
      if (event.type === "tool/result" || event.type === "tool/error") return false;
      if (event.type === "tool/started" || (event.type === "tool/call" && event.data.status === "running")) return true;
    }
    return false;
  });
  const [stopping, setStopping] = useState(false);
  const canStop = !!sessionId && toolActive && status === "running";
  useEffect(() => {
    if (!canStop) setStopping(false);
  }, [canStop]);
  const stop = () => {
    if (!sessionId || !canStop || stopping) return;
    setStopping(true);
    void api.abort(sessionId)
      .catch((error) => setUiError(error instanceof Error ? error.message : String(error)))
      .finally(() => setStopping(false));
  };
  const projectRoot = useStore((state) => {
    const id = state.activeProjectId;
    return id ? state.projectRegistry.projects.find((project) => project.id === id)?.path ?? null : null;
  });
  // Every row opens by hand only — folded while it runs, folded once settled.
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
  const pathParts = useMemo(
    () => presentation.path ? executionPathParts(presentation.path, projectRoot) : undefined,
    [presentation.path, projectRoot],
  );
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
  // Whatever the row already shows as a first-class surface is not repeated as
  // a technical key/value: the file card carries the path, the fragment's own
  // gutter carries the line range.
  const inputEntries = useMemo(() => {
    const shown = Boolean(presentation.path) || Boolean(presentation.files?.length);
    return normalizedInputEntries(message.input).filter((entry) =>
      !(shown && isPathDetailKey(entry.key))
      && !(presentation.kind === "read" && /^(?:offset|limit)$/i.test(entry.key)));
  }, [message, message.rev, presentation.files, presentation.path, presentation.kind]);
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
  // Only the newest collapsed summary prints out. Historical rows render in
  // full when session hydration remounts them.
  const summaryTitle = pathParts?.filename ?? presentation.label;
  const image = isImagePath(presentation.path) && !presentation.files?.length;
  const summaryPreview = pathParts
    ? [presentation.label, pathParts.directory].filter(Boolean).join(" · ")
    : presentation.preview;
  const typedPreview = usePrintText(summaryPreview, entering);

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
      <div className={`tool-card execution-row${entering ? " timeline-row-enter" : ""}${open ? " open" : ""}${status === "pending" || status === "running" ? " current" : ""}${status === "error" ? " error" : ""}${presentation.kind === "subagent" ? " execution-subagent" : ""}`}
        ref={rowRef}
        data-execution-kind={presentation.kind}
        onPointerDownCapture={() => {
          const timeline = rowRef.current?.closest<HTMLElement>(".timeline");
          pointerScrollAnchor.current = timeline
            ? { element: timeline, scrollTop: timeline.scrollTop, capturedAt: Date.now() }
            : null;
        }}
      >
        <div className="execution-summary-line">
          <button
            type="button"
            className="tool-disclosure execution-summary"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${summaryTitle}: ${summaryPreview}${
              hasLineChanges(stats) ? `, ${stats.add} added, ${stats.del} removed` : ""
            }`}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="tool-icon execution-icon" aria-hidden="true"><ExecutionIcon kind={presentation.kind} image={image} /></span>
            <span className="execution-main" title={presentation.path}>
              <span className="tool-name">
                {summaryTitle}
              </span>
              <span className={`tool-preview${presentation.kind === "shell" || presentation.kind === "test" ? " command" : ""}`}>{typedPreview}</span>
            </span>
            <span className="execution-diff-stat-slot">{hasLineChanges(stats) ? <DiffStat add={stats.add} del={stats.del} /> : null}</span>
            <StatusMark message={message} childStatus={subagent?.status} />
            <span className="tool-chevron" aria-hidden="true">{open ? <Icon.chevronUp /> : <Icon.chevronRight />}</span>
          </button>
          {canStop && (
            <Button
              className="execution-stop"
              variant="danger"
              size="sm"
              iconStart={StopIcon}
              busy={stopping}
              onClick={stop}
            >
              {tr("common.stop")}
            </Button>
          )}
        </div>
        <div className="execution-expand-shell" aria-hidden={!open}>
          <div className="execution-collapse-content">
          {detailsPresent && (
            <div className="tool-body execution-details">
              {presentation.command && <CommandDetail command={presentation.command} />}
              {subagent && <SubagentDetail subagent={subagent} />}
              {presentation.path && !presentation.files?.length && (
                image
                  ? <ImageDetail path={presentation.path} name={summaryTitle} />
                  : <FileTarget path={presentation.path} parts={pathParts} onOpen={openFile} />
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
              {todoItems && todoItems.length > 0 ? <TodoWritePreview items={todoItems} /> : presentation.kind !== "subagent" && inputEntries.length > 0 && (
                <section className="execution-detail-section execution-input">
                  <DetailHeading label="Details" />
                  <dl>
                    {inputEntries.map(({ key, value }) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
                  </dl>
                </section>
              )}
              {message.error !== undefined && (
                <OutputPreview text={message.error} error animate={entering} onOpenFull={() => openViewer(`${presentation.label} error`, message.error ?? "")} />
              )}
              {message.output !== undefined && !image && !isTrivialFileEditOutput(message.output, Boolean(presentation.files?.length)) && (
                presentation.kind === "search"
                  ? <SearchResults text={message.output} onOpenFull={() => openViewer(`${presentation.label} results`, message.output ?? "")} />
                  : presentation.kind === "mcp"
                    ? <McpResult output={message.output} />
                  : presentation.kind === "read"
                    ? <CodeFragment text={message.output} path={presentation.path} onOpenFull={() => openViewer(`${presentation.label} output`, message.output ?? "")} />
                  : <OutputPreview text={message.output} animate={entering} onOpenFull={() => openViewer(`${presentation.label} output`, message.output ?? "")} />
              )}
              {!presentation.files?.length && presentation.kind !== "subagent" && (
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
