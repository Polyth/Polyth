// Unified palette: commands, projects, chats, and files in one box.
// Mod+P opens file-focused mode; `is:archived` reveals archived sessions.
// Chats come from the one chat search (titles, branches, labels and message
// text, every project); its last row opens that search with the same query.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { commandHint, filterPalette, listCommands } from "../commands.ts";
import { api, type FileSearchHitDto, type SessionSearchResult, type WorkspaceSearchItemDto } from "@polyth/session/web-api";
import { searchHighlightRanges, searchTerms } from "@polyth/session/search-text";
import { activateProject, openEditorFile, openSessionSearch, setOverlay, setUiError, useStore } from "../store.ts";
import { openSession, refreshSessions } from "../init.ts";
import { tr } from "../i18n/index.ts";
import { useShellMode } from "../responsiveShell.ts";
import { commandIcon, ArchiveIcon, ChatIcon, CloseIcon, EditIcon, FileIcon, FolderIcon, Icon, IconButton, Menu, MoreIcon, PinIcon, ResponsiveOverlay, SearchIcon, Spinner, TextInput, type LucideIcon, type MenuEntry } from "./ui/index.ts";
import { highlightRuns, orderEntries, rankCommands, type PaletteEntry } from "../paletteOrdering.ts";
import { segmentHighlights } from "../sessionSearchQuery.ts";
import { isImeComposing } from "./input/editorCore.ts";
import { promptAlert } from "../alerts.ts";
import {
  archiveSessionWithPolicy,
  renameSessionTitle,
  toggleSessionPin,
  type SessionActionTarget,
} from "../sessionActions.ts";
import { friendlyError } from "../settings.ts";
import { compactResourcePath } from "@polyth/web-sdk";
import { resolveWorkspaceContext } from "@polyth/contracts/workspace";

// Chat verbs live in the row's overflow menu (⋯), so the row itself gives its
// whole width to the chat's title and second line.
type SessionPaletteVerb = "pin" | "rename" | "archive";
const SESSION_PALETTE_VERBS: readonly SessionPaletteVerb[] = [
  "pin",
  "rename",
  "archive",
];

/** Fixed-width leading slot so labels align whether or not a row has a glyph. */
function RowIcon({ glyph }: { glyph: LucideIcon | undefined }) {
  return <span className="palette-icon" aria-hidden="true">{glyph ? <Icon icon={glyph} size="sm" /> : null}</span>;
}

/** Label text with the matched query run emphasised. */
function Highlight({ text, query }: { text: string; query: string }) {
  const runs = highlightRuns(text, query);
  if (runs.length === 1 && !runs[0]!.match) return <>{text}</>;
  return <>{runs.map((run, n) => run.match ? <mark key={n}>{run.text}</mark> : <Fragment key={n}>{run.text}</Fragment>)}</>;
}

/** Text with the shared chat-search highlights (every word, or its stem). */
function TermHighlight({ text, ranges }: { text: string; ranges: ReadonlyArray<readonly [number, number]> }) {
  if (!ranges.length) return <>{text}</>;
  return <>{segmentHighlights(text, ranges).map((seg, n) => seg.hit ? <mark key={n}>{seg.text}</mark> : <Fragment key={n}>{seg.text}</Fragment>)}</>;
}

/** How many chats the palette shows before "All chats and messages…". */
const PALETTE_CHAT_LIMIT = 6;

/** A chat search result as a palette row: metadata hits show project · branch
 *  (the matched branch, else the chat's known branch), message-only hits show
 *  the matching excerpt. */
export function chatPaletteEntry(
  result: SessionSearchResult,
  projectName: string | undefined,
  knownBranch?: string,
): Extract<PaletteEntry, { kind: "workspace" }> {
  const message = result.matches.some((m) => m.field !== "message")
    ? undefined
    : result.matches.find((m) => m.field === "message");
  const branch = result.matches.find((m) => m.field === "branch")?.snippet ?? knownBranch;
  return {
    kind: "workspace",
    id: `session:${result.sessionId}`,
    item: {
      kind: "session",
      id: result.sessionId,
      projectId: result.projectId,
      title: result.title || tr("format.untitledSession2"),
      subtitle: [projectName, branch].filter(Boolean).join(" · "),
      status: result.status,
      ...(result.status === "archived" ? { archived: true } : {}),
      updatedAt: result.updatedAt,
    },
    ...(message ? { excerpt: { text: message.snippet, ranges: message.ranges ?? [] } } : {}),
  };
}

/** The arrow that points at a row's trailing actions (→, or ← in RTL). */
function inwardArrow(el: Element): "ArrowRight" | "ArrowLeft" {
  return el.ownerDocument.documentElement.dir === "rtl" ? "ArrowLeft" : "ArrowRight";
}

/** The inward arrow opens actions only once it can no longer move the caret. */
function caretAtEnd(el: HTMLInputElement): boolean {
  return el.selectionStart === el.selectionEnd && (el.selectionEnd ?? el.value.length) >= el.value.length;
}

/** Pull an `is:archived` token out of the raw query. */
export function parseQuery(raw: string): { text: string; archived: boolean } {
  const archived = /(^|\s)is:archived(\s|$)/i.test(raw);
  return { text: raw.replace(/(^|\s)is:archived(?=\s|$)/gi, " ").trim(), archived };
}

export default function CommandPalette() {
  const [q, setQ] = useState("");
  // Selection follows the entry, not its index, so late file/session results
  // never move the highlight out from under the user.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const navigatedBy = useRef<"key" | "pointer">("key");
  const inputRef = useRef<HTMLInputElement>(null);
  // The chat row whose actions menu is open (by entry id), if any.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [fileResults, setFileResults] = useState<{ scope: string; hits: FileSearchHitDto[] }>({ scope: "", hits: [] });
  const [workspaces, setWorkspaces] = useState<WorkspaceSearchItemDto[]>([]);
  const [chats, setChats] = useState<SessionSearchResult[]>([]);
  const seq = useRef(0);
  const shellMode = useShellMode();
  const phone = shellMode === "phone";
  const projectId = useStore((s) => s.activeProjectId);
  // File search resolves against the active session's worktree (P0).
  const sessionId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projectRegistry.projects);
  const project = projects.find((candidate) => candidate.id === projectId);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const repositories = useMemo(() => {
    if (!project || (sessionId && !session)) return [];
    try { return resolveWorkspaceContext(project, session).repositories.filter((repository) => repository.state === "ready"); }
    catch { return []; }
  }, [project, session, sessionId]);
  const mode = useStore((s) => s.paletteMode);
  const filesMode = mode === "files";
  const { text, archived } = useMemo(() => parseQuery(q), [q]);
  const fileScope = JSON.stringify([projectId, sessionId, text, repositories.map((repository) => repository.repositoryId)]);
  const files = fileResults.scope === fileScope ? fileResults.hits : [];

  const cmds = useMemo(
    () => (filesMode ? [] : rankCommands(filterPalette(listCommands(), text), text)),
    [filesMode, text],
  );
  useEffect(() => {
    setActiveId(null);
    setMenuFor(null);
    navigatedBy.current = "key";
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [q]);

  // Debounced remote searches; stale responses are dropped by sequence.
  useEffect(() => {
    const mySeq = ++seq.current;
    const wantFiles = !!projectId && text.length >= (filesMode ? 1 : 2);
    // `is:archived` alone lists recent archived sessions (server-bounded).
    const wantWorkspaces = !filesMode && (archived || text.length >= 2);
    // Chats (not archived-only listings) come from the one chat search.
    const wantChats = !filesMode && !archived && text.length >= 2;
    setFileResults({ scope: fileScope, hits: [] });
    if (!wantWorkspaces) setWorkspaces([]);
    if (!wantChats) setChats([]);
    setLoading(wantFiles || wantWorkspaces);
    if (!wantFiles && !wantWorkspaces) return;
    const h = setTimeout(() => {
      const pending: Promise<unknown>[] = [];
      if (wantFiles) {
        // One failing repository must not hide hits from the others.
        pending.push(Promise.allSettled(repositories.map(async (repository) =>
          (await api.filesSearchScored(projectId!, text, filesMode ? 20 : 8, false, sessionId ?? undefined, repository.repositoryId))
            .map((hit) => ({ ...hit, repositoryId: repository.repositoryId, repositoryAlias: repository.alias })),
        )).then((groups) => {
          const hits = groups.flatMap((group) => group.status === "fulfilled" ? group.value : []);
          if (mySeq === seq.current) setFileResults({ scope: fileScope, hits: hits.sort((a, b) => b.score - a.score).slice(0, filesMode ? 40 : 12) });
        }));
      }
      if (wantWorkspaces) {
        pending.push(api.searchWorkspaces(text, 10, archived).then((items) => {
          if (mySeq === seq.current) setWorkspaces(wantChats ? items.filter((item) => item.kind === "project") : items);
        }, () => {
          if (mySeq === seq.current) setWorkspaces([]);
        }));
      }
      if (wantChats) {
        pending.push(api.searchSessions(text, { limit: PALETTE_CHAT_LIMIT }).then((results) => {
          if (mySeq === seq.current) setChats(results);
        }, () => {
          if (mySeq === seq.current) setChats([]);
        }));
      }
      void Promise.allSettled(pending).then(() => {
        if (mySeq === seq.current) setLoading(false);
      });
    }, 150);
    return () => { clearTimeout(h); seq.current++; };
  }, [text, archived, filesMode, projectId, sessionId, fileScope, repositories]);

  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name] as const)), [projects]);
  const sessionBranch = useMemo(() => new Map(sessions.flatMap((s) => s.branch ? [[s.id, s.branch] as const] : [])), [sessions]);
  const terms = useMemo(() => searchTerms(text), [text]);
  const entries = useMemo<PaletteEntry[]>(
    () => orderEntries([
      ...cmds.map((c): PaletteEntry => ({ kind: "cmd", id: c.id, cmd: c })),
      ...workspaces.map((w): PaletteEntry => ({
        kind: "workspace",
        id: `${w.kind}:${w.id}`,
        item: w,
      })),
      ...chats.map((chat) => chatPaletteEntry(chat, projectName.get(chat.projectId), sessionBranch.get(chat.sessionId))),
      // Every typed query can continue in the full chat search; the phone
      // keeps the row on an empty query too, as its way into that search.
      ...(!filesMode && (phone || text.length >= 2)
        ? [{ kind: "session-search" as const, id: "session-search" as const }]
        : []),
      ...files.map((f): PaletteEntry => ({ kind: "file", id: JSON.stringify(["file", f.repositoryId, f.path]), hit: f })),
    ], shellMode),
    [cmds, workspaces, chats, projectName, sessionBranch, files, filesMode, phone, text, shellMode],
  );
  const found = activeId === null ? -1 : entries.findIndex((entry) => entry.id === activeId);
  const i = Math.max(found, 0);
  const selected = entries[i];
  const selectedSession = selected?.kind === "workspace" && selected.item.kind === "session"
    ? selected
    : null;
  // A row's actions menu closes when that row leaves the list.
  useEffect(() => {
    if (menuFor !== null && !entries.some((entry) => entry.id === menuFor)) setMenuFor(null);
  }, [entries, menuFor]);
  // Keyboard travel keeps the active row visible; pointer travel never
  // scrolls, so the list cannot slide under a resting cursor.
  useLayoutEffect(() => {
    if (navigatedBy.current !== "key") return;
    listRef.current?.querySelector(`#palette-opt-${i}`)?.scrollIntoView({ block: "nearest" });
  }, [i, entries]);
  const select = (n: number, by: "key" | "pointer") => {
    const entry = entries[n];
    navigatedBy.current = by;
    if (!entry || entry.id === selected?.id) return;
    setActiveId(entry.id);
  };

  const run = (entry: PaletteEntry, permanent = false) => {
    if (entry.kind === "session-search") {
      openSessionSearch({ query: archived ? `${text} is:archived`.trim() : text });
      return;
    }
    setOverlay(null);
    if (entry.kind === "cmd") {
      entry.cmd.run();
    } else if (entry.kind === "workspace") {
      // Capture ids now: activation must not race a store update mid-switch.
      const { kind, id } = entry.item;
      if (kind === "project") {
        activateProject(id);
      } else {
        // openSession switches the owning project first, atomically.
        void openSession(id).catch(() => {
          setUiError(tr("commandpalette.thatSessionNoLongerExists"), null, undefined, "warning");
        });
      }
    } else {
      openEditorFile(entry.hit.path, undefined, { preview: !permanent, repositoryId: entry.hit.repositoryId });
    }
  };
  const sessionTarget = (
    entry: Extract<PaletteEntry, { kind: "workspace" }>,
  ): SessionActionTarget => sessions.find((session) => session.id === entry.item.id)
    ?? {
      id: entry.item.id,
      title: entry.item.title,
      ...(entry.item.status ? { status: entry.item.status } : {}),
    };
  const runSessionVerb = async (
    entry: Extract<PaletteEntry, { kind: "workspace" }>,
    verb: SessionPaletteVerb,
  ) => {
    const target = sessionTarget(entry);
    setOverlay(null);
    try {
      if (verb === "archive") {
        await archiveSessionWithPolicy(target);
      } else if (verb === "pin") {
        await toggleSessionPin(
          target,
          sessions.filter((session) => session.pinned),
        );
        await refreshSessions(entry.item.projectId);
      } else {
        const next = await promptAlert(
          tr("mobile.sessionmenu.title"),
          {
            title: tr("mobile.sessionmenu.renameSession"),
            confirmLabel: tr("common.rename"),
            initialValue: target.title,
          },
        );
        if (next !== null) {
          await renameSessionTitle(target.id, target.title, next);
          await refreshSessions(entry.item.projectId);
        }
      }
    } catch (error) {
      setUiError(friendlyError(tr("common.error"), error));
    }
  };
  const sessionMenuEntries = (entry: Extract<PaletteEntry, { kind: "workspace" }>): MenuEntry[] => {
    const pinned = sessionTarget(entry).pinned;
    return SESSION_PALETTE_VERBS.map((verb) => ({
      id: verb,
      label: verb === "archive"
        ? tr("common.archive")
        : verb === "pin"
          ? pinned ? tr("sidebar.sessionlist.unpin") : tr("sidebar.sessionlist.pinToTop")
          : tr("common.rename"),
      icon: verb === "archive" ? ArchiveIcon : verb === "pin" ? PinIcon : EditIcon,
      onSelect: () => void runSessionVerb(entry, verb),
    }));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return; // IME safety
    const count = Math.max(entries.length, 1);
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      select(e.metaKey ? entries.length - 1 : (i + 1) % count, "key");
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      select(e.metaKey ? 0 : (i - 1 + count) % count, "key");
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      const step = e.key === "PageDown" ? 8 : -8;
      select(Math.min(Math.max(i + step, 0), entries.length - 1), "key");
    } else if (selectedSession && (e.key === "Tab" || (e.key === inwardArrow(e.currentTarget) && caretAtEnd(e.currentTarget)))) {
      // Tab (or the inward arrow at the end of the text) opens the active
      // chat's actions menu; focus moves into it, Escape returns to the field.
      e.preventDefault();
      navigatedBy.current = "key";
      setMenuFor(selectedSession.id);
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      run(selected, e.metaKey || e.ctrlKey);
    }
  };
  // Escape first clears a typed query, then closes. Runs in the capture phase
  // so it precedes the dialog's own Escape-to-close listener.
  const onKeyCapture = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape" || !q || isImeComposing(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setQ("");
  };

  const groupOf = (entry: PaletteEntry): string => {
    if (entry.kind === "cmd") return entry.cmd.group || tr("commandpalette.commands");
    if (entry.kind === "workspace") {
      return entry.item.kind === "project" ? tr("commandpalette.projects") : tr("commandpalette.sessions");
    }
    if (entry.kind === "session-search") return tr("commandpalette.sessions");
    return tr("commandpalette.files");
  };

  const dirOf = (p: string): string => {
    const idx = p.lastIndexOf("/");
    return idx < 0 ? "" : p.slice(0, idx);
  };
  const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
  const placeholder = filesMode
    ? tr("commandpalette.searchFiles")
    : tr("commandpalette.searchCommandsProjectsSessionsFilesIsArchived");
  const footer = (
    <div className="palette-footer" id="palette-close-hint">
      <span className="palette-footer-status" role="status" aria-live="polite">
        {loading ? tr("commandpalette.searching") : ""}
      </span>
      <span className="palette-keys">
        <span><kbd>↑</kbd><kbd>↓</kbd> {tr("commandpalette.navigate")}</span>
        <span><kbd>↵</kbd> {tr("commandpalette.open")}</span>
        {selectedSession && <span><kbd>Tab</kbd> {tr("commandpalette.actions")}</span>}
        <span><kbd>{tr("commandpalette.esc")}</kbd> {tr("commandpalette.close")}</span>
      </span>
    </div>
  );
  const contentOf = (entry: PaletteEntry) => (
    <>
      {entry.kind === "cmd" && (
        <>
          <RowIcon glyph={commandIcon(entry.cmd.icon)} />
          <span className="palette-label">
            <Highlight text={entry.cmd.label} query={text} />
            {entry.cmd.checked?.() && <span className="sr-only"> {tr("commandpalette.current")}</span>}
          </span>
          {entry.cmd.checked?.() && <span className="palette-check" aria-hidden="true">✓</span>}
          {commandHint(entry.cmd) && <kbd className="palette-kbd">{commandHint(entry.cmd)}</kbd>}
        </>
      )}
      {entry.kind === "workspace" && (
        <>
          <RowIcon glyph={entry.item.kind === "project" ? FolderIcon : ChatIcon} />
          <span className="palette-col">
            <span className="palette-title-line">
              <span className="palette-label">
                <TermHighlight text={entry.item.title} ranges={searchHighlightRanges(entry.item.title, terms)} />
              </span>
              {entry.item.archived && <span className="palette-status archived"><span className="sr-only">, </span>{tr("commandpalette.archived")}</span>}
            </span>
            {entry.excerpt
              ? <span className="palette-sub palette-excerpt"><TermHighlight text={entry.excerpt.text} ranges={entry.excerpt.ranges} /></span>
              : entry.item.subtitle && <span className="palette-sub">{entry.item.subtitle}</span>}
          </span>
          {entry.item.kind === "project" && <span className="palette-meta">{tr("commandpalette.switchProject")}</span>}
        </>
      )}
      {entry.kind === "session-search" && (
        <>
          <RowIcon glyph={SearchIcon} />
          <span className="palette-label">{text ? tr("commandpalette.allChatResults", { query: text }) : tr("commandpalette.searchInsideConversations")}</span>
          {!phone && <span className="palette-meta">{tr("shell.searchSessions")}</span>}
        </>
      )}
      {entry.kind === "file" && (
        <>
          <RowIcon glyph={entry.hit.kind === "dir" ? FolderIcon : FileIcon} />
          <span className="palette-col">
            <span className="palette-label mono"><Highlight text={baseOf(entry.hit.path)} query={text} /></span>
            {(dirOf(entry.hit.path) || repositories.length > 1) && <span className="palette-sub mono" title={entry.hit.path}>{repositories.length > 1 ? `${entry.hit.repositoryAlias} · ` : ""}{compactResourcePath(dirOf(entry.hit.path), phone ? 38 : 80)}</span>}
          </span>
          <span className="palette-meta">{entry.hit.kind === "dir" ? tr("commandpalette.folder") : tr("commandpalette.openInEditor")}</span>
        </>
      )}
    </>
  );

  return (
    <ResponsiveOverlay
      open
      onClose={() => setOverlay(null)}
      title={tr("commandpalette.searchWorkspace")}
      desktop="dialog"
      phone="sheet"
      dialogSize="lg"
      className="palette command-palette"
      initialFocus=".palette-input"
      sheetSize="tall"
      {...(phone
        ? {
            sheetSearch: {
              value: q,
              onChange: setQ,
              placeholder,
              ariaLabel: placeholder,
              role: "combobox" as const,
              ariaExpanded: entries.length > 0,
              ariaControls: "palette-listbox",
              ...(entries[i]
                ? { ariaActiveDescendant: `palette-opt-${i}` }
                : {}),
              onKeyDown: onKey,
            },
          }
        : {})}
      dialogFooter={footer}
      dialogHideHeader
      dialogDescribedBy="palette-description"
    >
      {!phone && (
        <div className="palette-field">
          <Icon icon={SearchIcon} className="palette-field-icon" />
          <TextInput
            ref={inputRef}
            className="palette-input"
            value={q}
            role="combobox"
            aria-expanded={entries.length > 0}
            aria-controls="palette-listbox"
            aria-activedescendant={entries[i] ? `palette-opt-${i}` : undefined}
            aria-autocomplete="list"
            aria-label={placeholder}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            onKeyDownCapture={onKeyCapture}
          />
          <span className="palette-field-trail">
            {loading && <Spinner size="sm" />}
            {!loading && q && (
              <IconButton icon={CloseIcon} size="sm" label={tr("sessionsearch.clear")} onClick={() => setQ("")} />
            )}
          </span>
          <span id="palette-description" className="sr-only">
            {tr("commandpalette.commandsProjectsSessionsAndFiles")}
          </span>
        </div>
      )}
      <div
        className="palette-list"
        role="listbox"
        id="palette-listbox"
        ref={listRef}
        aria-label={tr("commandpalette.paletteResults")}
        aria-busy={loading}
      >
        {entries.length === 0 && (
          <div className="palette-empty">
            {loading ? tr("commandpalette.searching") : tr("commandpalette.noMatches")}
          </div>
        )}
        {entries.map((entry, n) => (
          <Fragment key={entry.id}>
            {groupOf(entry) && (n === 0 || groupOf(entries[n - 1]!) !== groupOf(entry)) && (
              <div className="palette-group" role="presentation">{groupOf(entry)}</div>
            )}
            {entry.kind === "workspace" && entry.item.kind === "session" ? (
              <div
                className={`palette-item palette-session${n === i ? " active" : ""}`}
                role="option"
                id={`palette-opt-${n}`}
                aria-selected={n === i}
                onPointerMove={() => select(n, "pointer")}
              >
                <button className="palette-session-main" tabIndex={-1} onClick={() => run(entry)}>
                  {contentOf(entry)}
                </button>
                <Menu
                  label={`${tr("mobile.sessionmenu.sessionActions")}: ${entry.item.title}`}
                  title={entry.item.title}
                  entries={sessionMenuEntries(entry)}
                  align="end"
                  className="palette-session-menu"
                  open={menuFor === entry.id}
                  onOpenChange={(open) => setMenuFor(open ? entry.id : null)}
                  {...(phone ? {} : { returnFocusRef: inputRef })}
                >
                  {(trigger) => (
                    <IconButton
                      {...trigger}
                      icon={MoreIcon}
                      size="sm"
                      className="palette-session-more"
                      label={`${tr("mobile.sessionmenu.sessionActions")}: ${entry.item.title}`}
                      tabIndex={-1}
                    />
                  )}
                </Menu>
              </div>
            ) : (
              <button
                className={`palette-item${n === i ? " active" : ""}${entry.kind === "workspace" ? ` palette-${entry.item.kind}` : ""}`}
                role="option"
                id={`palette-opt-${n}`}
                aria-selected={n === i}
                tabIndex={-1}
                onPointerMove={() => select(n, "pointer")}
                onClick={(e) => run(entry, e.metaKey || e.ctrlKey)}
              >
                {contentOf(entry)}
              </button>
            )}
          </Fragment>
        ))}
      </div>
    </ResponsiveOverlay>
  );
}
