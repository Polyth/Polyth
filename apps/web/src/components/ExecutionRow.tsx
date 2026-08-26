import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { JsonObject } from "@polyth/contracts";
import { fmtMs } from "../format.ts";
import {
  executionPresentation,
  normalizedInputEntries,
  outputLineCount,
  type ExecutionKind,
} from "../execution.ts";
import { Icon } from "../icons.tsx";
import { openEditorFile } from "../store.ts";
import { parseDiffLines } from "../utils.ts";
import type { ToolMsg } from "../reduce.ts";
import CopyButton from "./CopyButton.tsx";

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

type DisplayStatus = "pending" | "done" | "error" | "cancelled";

function displayStatus(message: ToolMsg): DisplayStatus {
  if (message.status === "error" && /cancel(?:led|ed)|aborted|stopped/i.test(message.error ?? "")) return "cancelled";
  return message.status;
}

function StatusMark({ message }: { message: ToolMsg }) {
  const [now, setNow] = useState(() => Date.now());
  const status = displayStatus(message);
  useEffect(() => {
    if (status !== "pending") return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [status]);
  const elapsed = fmtMs(Math.max(0, (message.finishTime ?? now) - message.time));
  const label = status === "pending" ? "Running"
    : status === "error" ? "Failed"
      : status === "cancelled" ? "Cancelled"
        : "Succeeded";
  return (
    <span className={`execution-status ${status}`} aria-label={`${label} in ${elapsed}`}>
      <span className="execution-duration">{elapsed}</span>
      <span className="execution-status-icon" aria-hidden="true">
        {status === "pending" ? <span className="spinner" /> : status === "done" ? "✓" : status === "error" ? "×" : "—"}
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

function DiffPreview({ diff }: { diff: string }) {
  const lines = parseDiffLines(diff).slice(0, 14);
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

function FullOutputViewer({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(true);
  const filtered = useMemo(() => {
    if (!query.trim()) return text;
    const needle = query.toLowerCase();
    return text.split(/\r?\n/).filter((line) => line.toLowerCase().includes(needle)).join("\n");
  }, [query, text]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const viewer = (
    <div className="execution-viewer-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="execution-viewer" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <strong>{title}</strong>
          <span>{outputLineCount(text)} lines</span>
          <CopyButton text={text} label="Copy full output" />
          <button type="button" className="execution-viewer-close" onClick={onClose} aria-label="Close output viewer"><Icon.close /></button>
        </header>
        <div className="execution-viewer-tools">
          <label><Icon.search /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search output" /></label>
          <button type="button" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>Wrap {wrap ? "on" : "off"}</button>
        </div>
        <pre className={wrap ? "wrap" : ""}>{filtered || "No matching lines"}</pre>
      </section>
    </div>
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

export function ExecutionRow({ message }: { message: ToolMsg }) {
  const done = message.status !== "pending";
  const [open, setOpen] = useState(!done);
  const [viewer, setViewer] = useState<{ title: string; text: string } | null>(null);
  const presentation = executionPresentation(message);
  const inputEntries = normalizedInputEntries(message.input);
  const inputJson = JSON.stringify(message.input, null, 2);
  const raw = JSON.stringify({
    tool: message.tool,
    input: message.input,
    ...(message.output !== undefined ? { output: message.output } : {}),
    ...(message.error !== undefined ? { error: message.error } : {}),
    ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
  }, null, 2);
  const status = displayStatus(message);
  const exitCode = metadataValue(message.metadata, ["exit", "exitCode", "exit_code"]);
  const cwd = metadataValue(message.metadata, ["cwd"])
    ?? (typeof message.input.cwd === "string" ? message.input.cwd : undefined);
  const elapsed = fmtMs(Math.max(0, (message.finishTime ?? Date.now()) - message.time));
  const webUrl = typeof message.input.url === "string" ? message.input.url : undefined;

  useEffect(() => setOpen(!done), [done]);

  const openFile = () => {
    if (presentation.path) openEditorFile(presentation.path);
  };

  return (
    <>
      <div className={`tool-card execution-row${open ? " open" : ""}${status === "pending" ? " current" : ""}${status === "error" ? " error" : ""}`} data-execution-kind={presentation.kind}>
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
          <StatusMark message={message} />
          <span className="tool-chevron" aria-hidden="true">{open ? <Icon.chevronUp /> : <Icon.chevronRight />}</span>
        </button>
        <div className="execution-expand-shell" aria-hidden={!open}>
          {open && (
            <div className="tool-body execution-details">
              {presentation.command && <CommandDetail command={presentation.command} />}
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
              {presentation.diff && <DiffPreview diff={presentation.diff} />}
              {inputEntries.length > 0 && (
                <section className="execution-detail-section execution-input">
                  <DetailHeading label="Details" />
                  <dl>
                    {inputEntries.map(({ key, value }) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
                  </dl>
                </section>
              )}
              {message.error !== undefined && (
                <OutputPreview text={message.error} error onOpenFull={() => setViewer({ title: `${presentation.label} error`, text: message.error ?? "" })} />
              )}
              {message.output !== undefined && (
                presentation.kind === "search"
                  ? <SearchResults text={message.output} onOpenFull={() => setViewer({ title: `${presentation.label} results`, text: message.output ?? "" })} />
                  : <OutputPreview text={message.output} onOpenFull={() => setViewer({ title: `${presentation.label} output`, text: message.output ?? "" })} />
              )}
              <footer className="execution-metadata">
                {exitCode !== undefined && <span>Exit code {exitCode}</span>}
                <span>{elapsed}</span>
                {cwd && <span>cwd {cwd}</span>}
                {webUrl && <a href={webUrl} target="_blank" rel="noreferrer">Open link <Icon.external /></a>}
                <button type="button" onClick={() => setViewer({ title: `${presentation.label} raw result`, text: raw })}>View raw result</button>
                {!presentation.command && inputJson !== "{}" && <CopyButton text={inputJson} label="Copy tool input" />}
              </footer>
            </div>
          )}
        </div>
      </div>
      {viewer && <FullOutputViewer title={viewer.title} text={viewer.text} onClose={() => setViewer(null)} />}
    </>
  );
}

export default ExecutionRow;
