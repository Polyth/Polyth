import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { JsonObject } from "@polyth/contracts";
import { fmtMs } from "../format.ts";
import {
  executionPresentation,
  normalizedMcpResult,
  normalizedInputEntries,
  outputLineCount,
  type ExecutionKind,
} from "../execution.ts";
import { Icon } from "../icons.tsx";
import { openSession } from "../init.ts";
import { openEditorFile, setUiError, useStore } from "../store.ts";
import { parseDiffLines } from "../utils.ts";
import type { SubagentState, ToolMsg } from "../reduce.ts";
import CopyButton from "./CopyButton.tsx";
import Dialog from "./a11y/Dialog.tsx";

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

function CommandDetail({ command }: { command: string }) {
  return (
    <section className="execution-detail-section">
      <DetailHeading label="Command" copy={command} />
      <pre className="execution-command" tabIndex={0}>{command}</pre>
    </section>
  );
}

function DiffPreview({ diff, onOpenFull }: { diff: string; onOpenFull: () => void }) {
  const allLines = parseDiffLines(diff);
  const lines = allLines.slice(0, 14);
  return (
    <section className="execution-detail-section">
      <DetailHeading label="Changes" copy={diff} />
      <div className="execution-diff" role="region" aria-label="Change preview">
        {lines.map((line, index) => (
          <div key={`${index}:${line.text}`} className={`execution-diff-line ${line.kind}`}>
            <span>{index + 1}</span><code>{line.text || " "}</code>
          </div>
        ))}
      </div>
      {allLines.length > lines.length && (
        <div className="execution-output-actions">
          <button type="button" onClick={onOpenFull}>View full diff</button>
          <span>{allLines.length} lines</span>
        </div>
      )}
    </section>
  );
}

function OutputPreview({ text, error = false, onOpenFull }: {
  text: string;
  error?: boolean;
  onOpenFull: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const lines = outputLineCount(text);
  const long = lines > 12 || text.length > 1600;
  const shown = showAll ? text : text.split(/\r?\n/).slice(0, 12).join("\n");
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
  const modelLabel = descriptor?.name ?? model?.modelID ?? "Default model";
  const inheritedModel = childSession?.model === undefined;
  const parentLabel = parentSession?.title ?? "Current session";
  const openChild = () => {
    void openSession(subagent.sessionId).catch((error) =>
      setUiError(error instanceof Error ? error.message : String(error)));
  };
  const status = /^(?:done|completed|success|succeeded)$/i.test(subagent.status)
    ? "Completed"
    : /^(?:failed|error)$/i.test(subagent.status)
      ? "Failed"
      : /^(?:queued|pending)$/i.test(subagent.status)
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
      </div>
      <button type="button" onClick={openChild}>Open child session <Icon.external /></button>
    </section>
  );
}

interface TimelineScrollAnchor {
  element: HTMLElement;
  scrollTop: number;
}

function FullOutputViewer({ title, text, scrollAnchor, restoreTarget, onClose }: {
  title: string;
  text: string;
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
      <pre className={wrap ? "wrap" : ""}>{filtered || "No matching lines"}</pre>
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

export function ExecutionRow({
  message,
  subagent,
  activeTurn = false,
}: {
  message: ToolMsg;
  subagent?: Subagent;
  /** Preserve the announced call and input while the turn is still running. */
  activeTurn?: boolean;
}) {
  const status = displayStatus(message, subagent?.status);
  const done = status === "done" || status === "error" || status === "cancelled";
  const [open, setOpen] = useState(activeTurn || !done);
  const detailsPresent = useCollapsePresence(open);
  const rowRef = useRef<HTMLDivElement>(null);
  const pointerScrollAnchor = useRef<(TimelineScrollAnchor & { capturedAt: number }) | null>(null);
  const [viewer, setViewer] = useState<{
    title: string;
    text: string;
    scrollAnchor?: TimelineScrollAnchor;
    restoreTarget?: HTMLElement;
  } | null>(null);
  // Tool messages mutate in place; `rev` bumps on every mutation, so these
  // derivations (JSON.stringify of potentially large outputs) run once per
  // actual change instead of on every parent render.
  const presentation = useMemo(() => executionPresentation(message), [message, message.rev]);
  const inputEntries = useMemo(() => normalizedInputEntries(message.input), [message, message.rev]);
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
  const elapsed = fmtMs(Math.max(0, (message.finishTime ?? Date.now()) - message.time));
  const webUrl = typeof message.input.url === "string" ? message.input.url : undefined;

  useEffect(() => {
    if (!done) setOpen(true);
    else if (!activeTurn) setOpen(false);
  }, [activeTurn, done]);

  const openFile = () => {
    if (presentation.path) openEditorFile(presentation.path);
  };
  const openViewer = (title: string, text: string) => {
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
          aria-label={`${open ? "Collapse" : "Expand"} ${presentation.label}: ${presentation.preview}`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="tool-icon execution-icon" aria-hidden="true"><ExecutionIcon kind={presentation.kind} /></span>
          <span className="execution-main">
            <span className="tool-name">{presentation.label}</span>
            <span className={`tool-preview${presentation.kind === "shell" || presentation.kind === "test" ? " command" : ""}`}>{presentation.preview}</span>
          </span>
          <StatusMark message={message} childStatus={subagent?.status} />
          <span className="tool-chevron" aria-hidden="true">{open ? <Icon.chevronUp /> : <Icon.chevronRight />}</span>
        </button>
        <div className="execution-expand-shell" aria-hidden={!open}>
          <div className="execution-collapse-content">
          {detailsPresent && (
            <div className="tool-body execution-details">
              {presentation.command && <CommandDetail command={presentation.command} />}
              {subagent && <SubagentDetail subagent={subagent} />}
              {presentation.path && (
                <section className="execution-detail-section execution-file-summary">
                  <DetailHeading label="File" copy={presentation.path} />
                  <code>{presentation.path}</code>
                  <div className="execution-inline-actions">
                    <button type="button" onClick={openFile}>Open in Files</button>
                    <button type="button" onClick={openFile}>View full file</button>
                  </div>
                </section>
              )}
              {presentation.diff && (
                <DiffPreview
                  diff={presentation.diff}
                  onOpenFull={() => openViewer(`${presentation.label} full diff`, presentation.diff ?? "")}
                />
              )}
              {inputEntries.length > 0 && (
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
              {message.output !== undefined && (
                presentation.kind === "search"
                  ? <SearchResults text={message.output} onOpenFull={() => openViewer(`${presentation.label} results`, message.output ?? "")} />
                  : presentation.kind === "mcp"
                    ? <McpResult output={message.output} />
                  : <OutputPreview text={message.output} onOpenFull={() => openViewer(`${presentation.label} output`, message.output ?? "")} />
              )}
              <footer className="execution-metadata">
                {exitCode !== undefined && <span>Exit code {exitCode}</span>}
                <span>{elapsed}</span>
                {cwd && <span>cwd {cwd}</span>}
                {presentation.kind === "mcp" && <code className="execution-tool-id">{message.tool}</code>}
                {webUrl && <a href={webUrl} target="_blank" rel="noreferrer">Open link <Icon.external /></a>}
                <button type="button" onClick={() => openViewer(`${presentation.label} raw result`, raw)}>View raw result</button>
                {!presentation.command && inputJson !== "{}" && <CopyButton text={inputJson} label="Copy tool input" />}
              </footer>
            </div>
          )}
          </div>
        </div>
      </div>
      {viewer && <FullOutputViewer title={viewer.title} text={viewer.text} scrollAnchor={viewer.scrollAnchor} restoreTarget={viewer.restoreTarget} onClose={() => setViewer(null)} />}
    </>
  );
}

export default ExecutionRow;
