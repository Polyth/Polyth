// Unified/split diff rendering for Source Control. Line numbers come from the
// hunk headers, the +/− marker gets its own column so syntax highlighting sees
// the code without it, and multi-file patches render one section per file.
import { useState, type DragEvent, type ReactNode } from "react";
import { highlight, langOf } from "../../../apps/web/src/highlight.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import CopyButton from "../../../apps/web/src/components/CopyButton.tsx";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import type { DiffHunk } from "../../../apps/web/src/review/anchors.ts";
import {
  AddIcon,
  ChevronRightIcon,
  Icon as UiIcon,
  IconButton,
  MinusIcon,
  StageIcon,
  UndoIcon,
} from "../../../apps/web/src/components/ui/index.ts";
import { splitPrDiff } from "./prDiff.ts";
import { summarizeUnifiedDiff } from "./PendingChangesBar.tsx";
import type { GitHunkOperation } from "./hunkActions.ts";
import { LineStats, StatusChip, fileIdentity } from "./sourceControlParts.tsx";

export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
// File-level headers already have a home in the section title; repeating them
// as diff rows only pushes the code down.
const FILE_HEADER = /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |rename from |rename to |copy from |copy to )/;

export function parseDiffLines(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const raw = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n");
  for (const text of raw) {
    const header = HUNK_HEADER.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text });
      continue;
    }
    if (!inHunk || FILE_HEADER.test(text)) {
      if (FILE_HEADER.test(text)) { inHunk = false; continue; }
      lines.push({ kind: "meta", text });
      continue;
    }
    if (text.startsWith("+")) lines.push({ kind: "add", text: text.slice(1), newLine: newLine++ });
    else if (text.startsWith("-")) lines.push({ kind: "del", text: text.slice(1), oldLine: oldLine++ });
    else if (text.startsWith("\\")) lines.push({ kind: "meta", text });
    else lines.push({ kind: "ctx", text: text.startsWith(" ") ? text.slice(1) : text, oldLine: oldLine++, newLine: newLine++ });
  }
  return lines;
}

export function DiffCode({ line, path }: { line: string; path?: string }) {
  if (!path) return <span className="git-diff-code">{line}</span>;
  return <span className="git-diff-code" dangerouslySetInnerHTML={{ __html: highlight(line, langOf(path)) }} />;
}

const MARKER: Record<DiffLineKind, string> = { add: "+", del: "-", ctx: " ", hunk: "", meta: "" };
const ROW_CLASS: Record<DiffLineKind, string> = { add: "diff-add", del: "diff-del", ctx: "", hunk: "diff-hunk", meta: "diff-meta" };

/** One rendered row. The marker is a real `+`/`-` in the text stream (so a
 *  copied selection is still a patch) but sits in its own non-highlighted cell. */
function UnifiedRow({ line, path, children }: { line: DiffLine; path?: string; children?: ReactNode }) {
  if (line.kind === "hunk" || line.kind === "meta") {
    return (
      <div className={`git-diff-line ${ROW_CLASS[line.kind]}`}>
        <span className="git-diff-ln git-diff-ln--hunk" aria-hidden="true" />
        <span className="git-diff-hunk-text">{line.text}</span>
        {children}
      </div>
    );
  }
  return (
    <div className={`git-diff-line ${ROW_CLASS[line.kind]}`}>
      <span className="git-diff-ln" aria-hidden="true">{line.oldLine ?? ""}</span>
      <span className="git-diff-ln" aria-hidden="true">{line.newLine ?? ""}</span>
      <span className="git-diff-marker">{MARKER[line.kind]}</span>
      <DiffCode line={line.text} {...(path ? { path } : {})} />
    </div>
  );
}

function UnifiedBody({ diff, path }: { diff: string; path?: string }) {
  return <>{parseDiffLines(diff).map((line, index) => <UnifiedRow key={index} line={line} {...(path ? { path } : {})} />)}</>;
}

interface SplitRow {
  kind: "hunk" | "meta" | "pair";
  text?: string;
  left?: DiffLine;
  right?: DiffLine;
}

export function pairSplitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (line.kind === "hunk" || line.kind === "meta") { rows.push({ kind: line.kind, text: line.text }); i += 1; continue; }
    if (line.kind === "ctx") { rows.push({ kind: "pair", left: line, right: line }); i += 1; continue; }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === "add") adds.push(lines[i++]!);
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      rows.push({ kind: "pair", ...(dels[j] ? { left: dels[j] } : {}), ...(adds[j] ? { right: adds[j] } : {}) });
    }
  }
  return rows;
}

function SplitCell({ line, side, path }: { line?: DiffLine; side: "left" | "right"; path?: string }) {
  if (!line) return <div className="split-diff-cell split-diff-cell--empty"><span className="git-diff-ln" aria-hidden="true" /><span className="git-diff-marker" /><span className="git-diff-code" /></div>;
  const number = side === "left" ? line.oldLine : line.newLine;
  const kind = line.kind === "ctx" ? "" : ROW_CLASS[line.kind];
  return (
    <div className={`split-diff-cell ${kind}`}>
      <span className="git-diff-ln" aria-hidden="true">{number ?? ""}</span>
      <span className="git-diff-marker">{line.kind === "del" ? "-" : line.kind === "add" ? "+" : " "}</span>
      <DiffCode line={line.text} {...(path ? { path } : {})} />
    </div>
  );
}

function SplitBody({ diff, path }: { diff: string; path?: string }) {
  return (
    <>
      {pairSplitRows(parseDiffLines(diff)).map((row, index) => row.kind === "pair"
        ? <div className={`split-diff-row ${row.left?.kind === "ctx" ? "context" : "change"}`} key={index}>
            <SplitCell side="left" {...(row.left ? { line: row.left } : {})} {...(path ? { path } : {})} />
            <SplitCell side="right" {...(row.right ? { line: row.right } : {})} {...(path ? { path } : {})} />
          </div>
        : <div className={`split-diff-row ${row.kind === "hunk" ? "hunk" : "meta"}`} key={index}><span className="git-diff-hunk-text">{row.text}</span></div>)}
    </>
  );
}

interface DiffSyntaxSection {
  diff: string;
  path?: string;
}

/** Keep commit metadata unhighlighted and detect syntax independently for each file patch. */
export function diffSyntaxSections(diff: string, path?: string): DiffSyntaxSection[] {
  if (path) return [{ diff, path }];
  const firstFileHeader = diff.search(/^diff --git /m);
  if (firstFileHeader < 0) return [{ diff }];

  const sections: DiffSyntaxSection[] = [];
  const prelude = diff.slice(0, firstFileHeader);
  if (prelude) sections.push({ diff: prelude });
  for (const file of splitPrDiff(diff.slice(firstFileHeader))) {
    sections.push({ diff: file.diff, path: file.path });
  }
  return sections;
}

export function DiffSurface({ diff, path, split, wrap, children }: { diff: string; path?: string; split: boolean; wrap: boolean; children?: ReactNode }) {
  const Body = split ? SplitBody : UnifiedBody;
  return split
    ? <div className={`split-diff${wrap ? " wrap" : ""}`} {...(path ? { "data-diff-path": path } : {})}><Body diff={diff} {...(path ? { path } : {})} />{children}</div>
    : <pre className={`git-diff git-diff-page${wrap ? " wrap" : ""}`} {...(path ? { "data-diff-path": path } : {})}><Body diff={diff} {...(path ? { path } : {})} />{children}</pre>;
}

export function DiffContent({ diff, path, split, wrap }: { diff: string; path?: string; split: boolean; wrap: boolean }) {
  if (!diff) return <EmptyState variant="compact" title={tr("gitview.noTextualDiff")} description={tr("gitview.thisFileMayBeBinary")} />;
  const sections = diffSyntaxSections(diff, path);
  return (
    <div className="copy-wrap source-diff">
      {sections.map((section, index) => section.path
        ? <DiffSurface key={`${section.path}:${index}`} diff={section.diff} path={section.path} split={split} wrap={wrap} />
        // A bare patch (hunks without file headers) is still a diff; only
        // commit metadata before the first file stays a plain block.
        : /^@@ /m.test(section.diff)
          ? <DiffSurface key={`patch:${index}`} diff={section.diff} split={split} wrap={wrap} />
          : <pre key={`metadata:${index}`} className={`git-diff git-diff-page git-diff-prelude${wrap ? " wrap" : ""}`}>{section.diff.trimEnd()}</pre>)}
      <CopyButton text={diff} />
    </div>
  );
}

const patchStatus = (diff: string): string => {
  if (/^new file mode /m.test(diff)) return "added";
  if (/^deleted file mode /m.test(diff)) return "deleted";
  if (/^rename from /m.test(diff)) return "renamed";
  return "modified";
};

/** A commit's patch as one collapsible section per file, in Git's own order.
 *  Every section starts open; "Collapse all" folds them. */
export function CommitFiles({ diff, split, wrap }: { diff: string; split: boolean; wrap: boolean }) {
  const start = diff.search(/^diff --git /m);
  const files = start < 0 ? [] : splitPrDiff(diff.slice(start));
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  if (files.length === 0) return <DiffContent diff={diff} split={split} wrap={wrap} />;
  const totals = files.reduce((sum, file) => {
    const stats = summarizeUnifiedDiff(file.diff);
    return { additions: sum.additions + stats.additions, deletions: sum.deletions + stats.deletions };
  }, { additions: 0, deletions: 0 });
  const allClosed = files.every((file) => closed.has(file.path));
  return (
    <div className="source-commit-files">
      <div className="source-commit-files-head">
        <strong>{files.length === 1 ? tr("gitview.oneChangedFile") : tr("gitview.changedFilesValue", { count: files.length })}</strong>
        <LineStats stats={totals} />
        <span className="header-spacer" />
        <button type="button" className="source-text-btn" onClick={() => setClosed(allClosed ? new Set() : new Set(files.map((file) => file.path)))}>
          {allClosed ? tr("gitview.expandAll") : tr("gitview.collapseAll")}
        </button>
      </div>
      {files.map((file) => {
        const isClosed = closed.has(file.path);
        const identity = fileIdentity(file.path);
        const stats = summarizeUnifiedDiff(file.diff);
        return (
          <section className="source-file-section" key={file.path} data-diff-path={file.path}>
            <button type="button" className="source-file-section-head" aria-expanded={!isClosed} title={file.path} onClick={() => setClosed((current) => {
              const next = new Set(current);
              if (next.has(file.path)) next.delete(file.path); else next.add(file.path);
              return next;
            })}>
              <span className={`git-folder-chevron${isClosed ? "" : " expanded"}`} aria-hidden="true"><UiIcon icon={ChevronRightIcon} size="sm" /></span>
              <StatusChip status={patchStatus(file.diff)} />
              <span className="source-file-section-name">{identity.name}</span>
              <span className="source-file-section-dir">{identity.directory}</span>
              <LineStats stats={stats} />
            </button>
            {!isClosed && <div className="copy-wrap"><DiffSurface diff={file.diff} path={file.path} split={split} wrap={wrap} /><CopyButton text={file.diff} /></div>}
          </section>
        );
      })}
    </div>
  );
}

/** Commit message + metadata lines that `git show` prints before the patch. */
export function parseCommitPrelude(diff: string): { body: string } {
  const start = diff.search(/^diff --git /m);
  const prelude = start < 0 ? diff : diff.slice(0, start);
  const lines = prelude.split("\n");
  const blank = lines.findIndex((line) => line.trim() === "");
  const message = (blank < 0 ? [] : lines.slice(blank + 1))
    .map((line) => line.replace(/^ {4}/, ""))
    .join("\n")
    .trim();
  // The first message line is the subject the log already shows.
  const [, ...rest] = message.split("\n");
  return { body: rest.join("\n").trim() };
}

export function HunkBlock({ hunk, path, staged, busy, canMutate, onDragStart, onMutate, onComment }: {
  hunk: DiffHunk;
  hunkIndex: number;
  path: string;
  staged: boolean;
  busy: boolean;
  canMutate: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onMutate: (operation: GitHunkOperation) => void;
  onComment?: () => void;
}) {
  const lines = parseDiffLines([hunk.header, ...hunk.body].join("\n"));
  const [header, ...body] = lines;
  return (
    <div className="git-hunk">
      <div className="git-diff-line diff-hunk" draggable={Boolean(onDragStart)} onDragStart={onDragStart}>
        <span className="git-diff-ln git-diff-ln--hunk" aria-hidden="true" />
        <span className="git-diff-hunk-text">{header?.text ?? hunk.header}</span>
        <span className="hunk-action-group">
          <IconButton
            icon={staged ? MinusIcon : StageIcon}
            size="sm"
            variant="ghost"
            className="hunk-action-btn"
            title={staged ? tr("gitview.unstage") : tr("gitview.stage")}
            label={staged ? tr("gitview.unstage") : tr("gitview.stage")}
            disabled={busy || !canMutate}
            onClick={() => onMutate(staged ? "unstage" : "stage")}
          />
          {!staged && (
            <IconButton
              icon={UndoIcon}
              size="sm"
              variant="ghost"
              className="hunk-action-btn"
              title={tr("gitview.revert")}
              label={tr("gitview.revert")}
              disabled={busy || !canMutate}
              onClick={() => onMutate("discard")}
            />
          )}
          {onComment && <IconButton icon={AddIcon} size="sm" variant="ghost" className="hunk-comment-btn hunk-action-btn" title={tr("gitview.addReviewNoteForThisHunk")} label={tr("gitview.addReviewNote")} onClick={onComment} />}
        </span>
      </div>
      {body.map((line, index) => <UnifiedRow key={index} line={line} path={path} />)}
    </div>
  );
}

export function DiffSkeleton() {
  return (
    <div className="diff-skeleton" aria-label={tr("gitview.loadingDiff")} aria-busy="true">
      <span /><span /><span /><span /><span />
    </div>
  );
}
