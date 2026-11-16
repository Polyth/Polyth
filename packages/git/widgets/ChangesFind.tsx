// Find in changes: Cmd/Ctrl+F while focus is inside the Changes view opens a
// bar that searches every changed file's diff text (added, removed, context),
// not only the file on screen. Diffs are fetched a few at a time and searched
// in time-boxed slices (diffFind.ts); matches are painted with the CSS Custom
// Highlight API, so the diff DOM is never rewritten.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { ChangesetSearch, stepMatch, type FindMatch } from "./diffFind.ts";

export interface FindFile { key: string; path: string }

const SLICE_MS = 12;
const LOAD_CONCURRENCY = 3;

interface HighlightRegistry { set(name: string, value: unknown): void; delete(name: string): void }
const registry = (): HighlightRegistry | null => (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights ?? null;

/** Every occurrence of the needle in the displayed file's code cells, in
 *  reading order (a split view's mirrored context cell is skipped). */
export function codeOccurrences(container: Element, query: string, matchCase: boolean): { element: Element; start: number }[] {
  const needle = matchCase ? query : query.toLowerCase();
  const out: { element: Element; start: number }[] = [];
  if (!needle) return out;
  for (const element of Array.from(container.querySelectorAll(".git-diff-code"))) {
    const cell = element.closest(".split-diff-cell");
    if (cell && cell.parentElement?.classList.contains("context") && cell.nextElementSibling === null) continue;
    const text = matchCase ? element.textContent ?? "" : (element.textContent ?? "").toLowerCase();
    for (let from = 0; ;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      out.push({ element, start: at });
      from = at + Math.max(1, needle.length);
    }
  }
  return out;
}

function rangeFor(element: Element, start: number, length: number): Range | null {
  const walker = document.createTreeWalker(element, 4 /* SHOW_TEXT */);
  let offset = 0;
  let from: { node: Node; at: number } | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const size = node.textContent?.length ?? 0;
    if (!from && start < offset + size) from = { node, at: start - offset };
    if (from && start + length <= offset + size) {
      const range = document.createRange();
      range.setStart(from.node, from.at);
      range.setEnd(node, start + length - offset);
      return range;
    }
    offset += size;
  }
  return null;
}

function paint(root: Element, path: string, query: string, matchCase: boolean, currentOrd: number): void {
  const highlights = registry();
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  root.querySelectorAll("[data-find-current]").forEach((node) => node.removeAttribute("data-find-current"));
  const container = Array.from(root.querySelectorAll("[data-diff-path]")).find((node) => node.getAttribute("data-diff-path") === path);
  if (!container) { highlights?.delete("git-find"); highlights?.delete("git-find-current"); return; }
  const found = codeOccurrences(container, query, matchCase);
  const current = found[currentOrd];
  if (current) {
    const row = current.element.closest(".git-diff-line, .split-diff-cell");
    row?.setAttribute("data-find-current", "");
    (row ?? current.element).scrollIntoView?.({ block: "center", inline: "nearest" });
  }
  if (!highlights || !Highlight) return;
  const all: Range[] = [];
  let currentRange: Range | null = null;
  found.forEach((item, index) => {
    const range = rangeFor(item.element, item.start, query.length);
    if (!range) return;
    if (index === currentOrd) currentRange = range; else all.push(range);
  });
  highlights.set("git-find", new Highlight(...all));
  if (currentRange) highlights.set("git-find-current", new Highlight(currentRange)); else highlights.delete("git-find-current");
}

export interface ChangesFindOptions {
  host: WebPackageHost | undefined;
  files: readonly FindFile[];
  /** Resolves a file's unified diff text, or null when it has none to search. */
  loadDiff: (file: FindFile) => Promise<string | null>;
  /** Show the file (select it / expand it) so its diff is in the DOM. */
  reveal: (file: FindFile) => void;
  /** Element that contains the displayed diffs. */
  root: RefObject<HTMLElement | null>;
  /** Changes when the set/contents of changed files change; drops the cache. */
  signature: string;
}

export function useChangesFind({ host, files, loadDiff, reveal, root, signature }: ChangesFindOptions) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [cursor, setCursor] = useState<{ file: string; ord: number } | null>(null);
  const [, setTick] = useState(0);
  const diffs = useRef(new Map<string, string | null>());
  const search = useRef<ChangesetSearch | null>(null);
  const restore = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const jumpToFirst = useRef(true);
  const loadDiffRef = useRef(loadDiff); loadDiffRef.current = loadDiff;
  const revealRef = useRef(reveal); revealRef.current = reveal;
  const fileList = useRef(files); fileList.current = files;
  const [loading, setLoading] = useState(false);

  useEffect(() => { diffs.current = new Map(); }, [signature]);

  // Search driver: fetch missing diffs a few at a time, search in slices.
  useEffect(() => {
    if (!open || !query) { search.current = null; setLoading(false); return; }
    const session = new ChangesetSearch(query, matchCase, files.map((file) => file.key));
    search.current = session;
    jumpToFirst.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = files.filter((file) => !diffs.current.has(file.key));
    let inflight = 0;
    for (const file of files) { const cached = diffs.current.get(file.key); if (cached) session.add(file.key, cached); else if (diffs.current.has(file.key)) session.add(file.key, ""); }
    const schedule = () => { if (!timer && !cancelled) timer = setTimeout(run, 0); };
    const run = () => {
      timer = undefined;
      if (cancelled) return;
      const done = session.step(SLICE_MS);
      setTick((value) => value + 1);
      if (!done) schedule();
      else if (inflight === 0 && pending.length === 0) setLoading(false);
    };
    const pump = () => {
      while (!cancelled && inflight < LOAD_CONCURRENCY && pending.length > 0) {
        const file = pending.shift()!;
        inflight += 1;
        void loadDiffRef.current(file).catch(() => null).then((text) => {
          if (cancelled) return;
          diffs.current.set(file.key, text);
          session.add(file.key, text ?? "");
          inflight -= 1;
          schedule();
          pump();
        });
      }
    };
    setLoading(pending.length > 0);
    schedule();
    pump();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [open, query, matchCase, signature, files.map((file) => file.key).join("\0")]);

  const matches: FindMatch[] = search.current?.matches() ?? [];
  const total = matches.length;
  const index = cursor ? matches.findIndex((match) => match.file === cursor.file && match.ord === cursor.ord) : -1;

  // First result of a fresh query becomes current; later files finishing do not steal it.
  useEffect(() => {
    if (!open || !jumpToFirst.current || matches.length === 0) return;
    jumpToFirst.current = false;
    const first = matches[0]!;
    setCursor({ file: first.file, ord: first.ord });
  });
  useEffect(() => { if (!query) setCursor(null); }, [query]);

  const currentMatch = index >= 0 ? matches[index] : undefined;
  const currentFile = currentMatch ? files.find((file) => file.key === currentMatch.file) : undefined;
  useEffect(() => { if (open && currentFile) revealRef.current(currentFile); }, [open, currentFile?.key, cursor?.ord]);

  // Paint after the revealed file's diff is in the DOM (it may load after reveal).
  useEffect(() => {
    const host = root.current;
    const clear = () => { registry()?.delete("git-find"); registry()?.delete("git-find-current"); root.current?.querySelectorAll("[data-find-current]").forEach((node) => node.removeAttribute("data-find-current")); };
    if (!open || !query || !host || !currentFile || !currentMatch) { clear(); return; }
    let frame = 0;
    const apply = () => { frame = 0; paint(host, currentFile.path, query, matchCase, currentMatch.ord); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
    apply();
    const observer = new MutationObserver(schedule);
    observer.observe(host, { childList: true, subtree: true });
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); clear(); };
  }, [open, query, matchCase, currentFile?.path, currentMatch?.ord, currentMatch?.file]);

  const go = useCallback((delta: 1 | -1) => {
    const list = search.current?.matches() ?? [];
    const at = cursor ? list.findIndex((match) => match.file === cursor.file && match.ord === cursor.ord) : -1;
    const next = stepMatch(at, list.length, delta);
    const match = list[next];
    if (match) setCursor({ file: match.file, ord: match.ord });
  }, [cursor]);

  const close = useCallback(() => {
    setOpen(false);
    const target = restore.current ?? root.current;
    restore.current = null;
    setTimeout(() => target?.focus?.(), 0);
  }, [root]);

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) restore.current = (document.activeElement as HTMLElement | null) ?? null;
      setOpen(true);
      setTimeout(() => { input.current?.focus(); input.current?.select(); }, 0);
    }
  };

  const bar = open && host ? (
    <FindBar
      host={host}
      inputRef={input}
      query={query}
      onQuery={setQuery}
      matchCase={matchCase}
      onMatchCase={() => setMatchCase((value) => !value)}
      total={total}
      position={index >= 0 ? index + 1 : 0}
      searching={loading || !(search.current?.done ?? true)}
      onNext={() => go(1)}
      onPrevious={() => go(-1)}
      onClose={close}
    />
  ) : null;
  return { open, bar, onKeyDown, total, position: index + 1 };
}

export function FindBar({ host, inputRef, query, onQuery, matchCase, onMatchCase, total, position, searching, onNext, onPrevious, onClose }: {
  host: WebPackageHost;
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (value: string) => void;
  matchCase: boolean;
  onMatchCase: () => void;
  total: number;
  position: number;
  searching: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}) {
  const { TextInput, Button, IconButton } = host.ui.components;
  const icons = host.ui.iconSet;
  const ChevronUpIcon = icons?.ChevronUpIcon ?? (() => "↑");
  const ChevronDownIcon = icons?.ChevronDownIcon ?? (() => "↓");
  const CloseIcon = icons?.CloseIcon ?? (() => "×");
  const t = useMemo(() => (key: string, values?: Record<string, string | number>) => host.ui.locale.translate(key, values), [host]);
  const status = !query ? "" : total > 0 ? t("diffFind.count", { current: position || 1, total }) : searching ? t("diffFind.searching") : t("diffFind.none");
  return (
    <div className="git-find-bar" role="search" aria-label={t("diffFind.label")}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        else if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); if (event.shiftKey) onPrevious(); else onNext(); }
      }}>
      <TextInput ref={inputRef} uiSize="sm" className="git-find-input" value={query} placeholder={t("diffFind.placeholder")} aria-label={t("diffFind.label")} onChange={(event) => onQuery(event.target.value)} />
      <span className="git-find-count muted" role="status" aria-live="polite">{status}</span>
      <Button size="sm" variant="ghost" aria-pressed={matchCase} title={t("diffFind.matchCase")} onClick={onMatchCase}>Aa</Button>
      <IconButton icon={ChevronUpIcon} size="sm" variant="ghost" label={t("diffFind.previous")} disabled={total === 0} onClick={onPrevious} />
      <IconButton icon={ChevronDownIcon} size="sm" variant="ghost" label={t("diffFind.next")} disabled={total === 0} onClick={onNext} />
      <IconButton icon={CloseIcon} size="sm" variant="ghost" label={t("diffFind.close")} onClick={onClose} />
    </div>
  );
}
