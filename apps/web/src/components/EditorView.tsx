// UX-PANE-MODEL / EXTENSION-SEAMS slice 3: the canonical Files surface.
// EditorView is the file-tree and open-resource COORDINATOR — the generic tab
// strip, dirty guarding, keyboard cycling, and kept-alive resource bodies all
// live in the shared workspace/PaneHost; one file's document lifecycle lives
// in editor/FilePane. This file implements no tab store and no second editor.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { api, type FileEntry } from "../api.ts";
import { closeWorkspacePane, getState, openEditorFile, useStore } from "../store.ts";
import EmptyState from "./EmptyState.tsx";
import { requestComposerInsert } from "../composerInsert.ts";
import { setDragPath } from "../dnd.ts";
import { MOD } from "../format.ts";
import { useEscape } from "../useEscape.ts";
import { usePaneVisible } from "../workspace/paneVisibility.ts";
import { setPaneLastResource } from "../workspace/panePrefs.ts";
import type { PaneTab } from "../workspace/paneStore.ts";
import PaneHost, { type PaneHostHandle } from "./workspace/PaneHost.tsx";
import FileRowActions from "./FileRowActions.tsx";
import { ChevronGlyph, FileTypeGlyph, FolderGlyph, fileTypeKeyOf } from "../editor/fileTreeIcons.tsx";
import { Icon } from "../icons.tsx";
import { confirmAlert, promptAlert } from "../alerts.ts";
import { desktopBridge } from "../desktopBridge.ts";
import "./editor/FilePane.tsx"; // registers the "file" pane provider
import "../workspace/mainSlotPanes.ts";
import { tr } from "../i18n/index.ts"; // registers the "plugin" slot bridge

interface Row {
  e: FileEntry;
  depth: number;
}

const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");
const baseOf = (p: string) => p.split("/").pop() ?? p;
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const TREE_REFRESH_MS = 8_000;
// Stable DOM id per tree row for aria-activedescendant (encode: ids may not
// contain whitespace, and paths may).
const treeItemId = (p: string) => `ft-item-${encodeURIComponent(p)}`;

interface CtxMenu {
  x: number;
  y: number;
  entry: FileEntry;
}

export default function EditorView() {
  const projectId = useStore((s) => s.activeProjectId);
  const project = useStore((s) => s.projectRegistry.projects.find((candidate) => candidate.id === s.activeProjectId));
  // Files must follow the ACTIVE SESSION's worktree, not the project root
  // (UX-FIXTURE-VISUAL P0): every files call carries the session id.
  const sessionId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => s.sessions.find((candidate) => candidate.id === s.activeSessionId));
  const sid = sessionId ?? undefined;
  const filePath = useStore((s) => s.editorFile);
  const visible = usePaneVisible();

  // ---- tree ----------------------------------------------------------------
  const [kids, setKids] = useState<Record<string, FileEntry[]>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [sel, setSel] = useState("");
  const [treeErr, setTreeErr] = useState("");
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<string[] | null>(null);
  const [mobileStage, setMobileStage] = useState<"tree" | "editor">("tree");

  const paneRef = useRef<PaneHostHandle>(null);
  const [activeTab, setActiveTab] = useState<PaneTab | null>(null);
  const activePath = activeTab && activeTab.kind === "file" && !activeTab.unavailable ? activeTab.resource : null;

  const loadDir = async (p: string) => {
    if (!projectId) return;
    try {
      const entries = await api.filesTree(projectId, p || undefined, undefined, sid);
      setKids((k) => ({ ...k, [p]: entries }));
      setTreeErr("");
    } catch (err) {
      setTreeErr(msg(err));
    }
  };

  // A session switch can move the filesystem root to that session's worktree,
  // so cached listings are stale (UX-FIXTURE-VISUAL P0).
  useEffect(() => {
    setKids({});
    setOpen(new Set());
    setSel("");
    setCtx(null);
    setSearchResults(null);
    setQuery("");
    setMobileStage("tree");
    if (projectId) void loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId]);

  // Store-driven opens (file refs in chat, palette, adapters) become tabs.
  useEffect(() => {
    if (!filePath) return;
    paneRef.current?.open("file", filePath, baseOf(filePath));
    setSel(filePath);
    setMobileStage("editor");
  }, [filePath]);

  // Active tab drives the store channel + the project-scoped last resource.
  const onActiveChange = (tab: PaneTab | null) => {
    setActiveTab(tab);
    const next = tab && tab.kind === "file" && !tab.unavailable ? tab.resource : null;
    if (getState().editorFile !== next) openEditorFile(next);
    if (next !== null) {
      setSel(next);
      setMobileStage("editor");
      if (projectId) setPaneLastResource(projectId, "files", `file:${next}`);
    } else {
      setMobileStage("tree");
    }
  };

  // One tree-refresh owner per visible workspace scope; hidden panes and
  // hidden browser tabs do no filesystem work.
  useEffect(() => {
    if (!projectId || !visible) return;
    const refreshVisible = () => {
      if (document.visibilityState === "hidden") return;
      for (const path of new Set(["", ...open])) void loadDir(path);
    };
    const onFocus = () => refreshVisible();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshVisible();
    };
    const onFilesChanged = () => refreshVisible();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("polyth:files-changed", onFilesChanged);
    const timer = setInterval(refreshVisible, TREE_REFRESH_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("polyth:files-changed", onFilesChanged);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, visible, open]);

  const toggle = (p: string) => {
    if (!open.has(p) && !kids[p]) void loadDir(p);
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  };

  const openFile = (fp: string) => {
    setSel(fp);
    setMobileStage("editor");
    openEditorFile(fp); // store channel → effect turns it into a tab
  };

  // ---- search (files search from the panel days, kept as a canonical action) ---
  const search = async () => {
    if (!projectId || !query.trim()) {
      setSearchResults(null);
      return;
    }
    try {
      setSearchResults(await api.filesSearch(projectId, query.trim(), 50, sid));
      setTreeErr("");
    } catch (err) {
      setTreeErr(msg(err));
    }
  };

  // ---- chat inserts ----------------------------------------------------------
  const attachPath = (fp: string) => {
    requestComposerInsert(`@${fp}`);
  };

  // ---- tree context menu actions ------------------------------------------------
  const ctxRename = async (entry: FileEntry) => {
    if (!projectId) return;
    const to = (await promptAlert(tr("editorview.renameOrMoveThisItem"), { title: tr("editorview.renameMoveTitle"), initialValue: entry.path, confirmLabel: tr("common.rename") }))?.trim();
    if (!to || to === entry.path) return;
    try {
      await api.filesRename(projectId, entry.path, to, sid);
      await Promise.all([loadDir(parentOf(entry.path)), loadDir(parentOf(to))]);
      if (!entry.dir) paneRef.current?.rename("file", entry.path, to, baseOf(to));
    } catch (err) {
      setTreeErr(msg(err));
    }
  };

  const ctxDelete = async (entry: FileEntry) => {
    if (!projectId) return;
    if (!await confirmAlert(tr("editorview.deleteValueValue", { path: entry.path, value: entry.dir ? tr("editorview.andItsContents") : "" }), { title: tr("editorview.deleteItem"), confirmLabel: tr("common.delete") })) return;
    try {
      await api.filesDelete(projectId, entry.path, sid);
      await loadDir(parentOf(entry.path));
      if (!entry.dir) paneRef.current?.close("file", entry.path, { force: true });
    } catch (err) {
      setTreeErr(msg(err));
    }
  };

  const ctxNew = async (dirPath: string, kind: "file" | "folder") => {
    if (!projectId) return;
    const name = (await promptAlert(tr("editorview.enterTheNewValueName", { kind: kind }), { title: tr("editorview.newValue", { kind: kind }), confirmLabel: tr("common.create") }))?.trim();
    if (!name) return;
    const rel = dirPath ? `${dirPath}/${name}` : name;
    try {
      if (kind === "folder") await api.filesMkdir(projectId, rel, sid);
      else await api.filesWrite(projectId, rel, "", undefined, sid);
      await loadDir(dirPath);
      setOpen((o) => new Set(o).add(dirPath));
      if (kind === "file") openFile(rel);
    } catch (err) {
      setTreeErr(msg(err));
    }
  };

  const revealNative = async (entry: FileEntry) => {
    const desktop = desktopBridge();
    const root = session?.worktreePath ?? project?.path;
    if (!desktop || !root || project?.remote) return;
    const separator = root.includes("\\") ? "\\" : "/";
    const absolute = `${root.replace(/[\\/]$/, "")}${separator}${entry.path.replaceAll("/", separator)}`;
    try {
      if (entry.dir) await desktop.openPath(absolute);
      else await desktop.revealPath(absolute);
    } catch (error) {
      setTreeErr(msg(error));
    }
  };

  useEscape(ctx !== null, () => setCtx(null));

  // Escape with no open document closes the Files pane (non-terminal Escape
  // → the command path restores focus to the invoker). FilePane owns Escape
  // while a document is active.
  useEffect(() => {
    if (!visible) return;
    const h = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (ctx) return; // the context menu's own Escape handler closes it
      if (activeTab === null) closeWorkspacePane();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [visible, ctx, activeTab]);

  // ---- tree rows -----------------------------------------------------------------
  const rows: Row[] = [];
  const walk = (p: string, depth: number) => {
    for (const e of kids[p] ?? []) {
      rows.push({ e, depth });
      if (e.dir && open.has(e.path)) walk(e.path, depth + 1);
    }
  };
  walk("", 0);

  // Keyboard selection moves the active descendant, not DOM focus — keep the
  // selected row visible in long trees.
  const selectRow = (path: string) => {
    setSel(path);
    document.getElementById(treeItemId(path))?.scrollIntoView({ block: "nearest" });
  };

  const onTreeKey = (e: KeyboardEvent) => {
    const i = rows.findIndex((r) => r.e.path === sel);
    const cur = rows[i]?.e;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[e.key === "ArrowDown" ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)];
      if (next) selectRow(next.e.path);
    } else if (e.key === "ArrowRight" && cur?.dir && !open.has(cur.path)) {
      toggle(cur.path);
    } else if (e.key === "ArrowLeft" && cur) {
      if (cur.dir && open.has(cur.path)) toggle(cur.path);
      else if (parentOf(cur.path)) selectRow(parentOf(cur.path));
    } else if (e.key === "Enter" && cur) {
      if (cur.dir) toggle(cur.path);
      else openFile(cur.path);
    }
  };

  const onRowContext = (ev: MouseEvent, entry: FileEntry) => {
    ev.preventDefault();
    setSel(entry.path);
    setCtx({ x: ev.clientX, y: ev.clientY, entry });
  };

  if (!projectId) return <EmptyState title={tr("editorview.noProjectSelected")} description={tr("editorview.openAProjectToBrowseAndEdit")} />;

  return (
    <div className={`editor-view mobile-${mobileStage}`}>
      <nav className="editor-mobile-tabs" aria-label={tr("workspace.panehost.openResources")}>
        <button
          type="button"
          className={mobileStage === "tree" ? "active" : ""}
          aria-current={mobileStage === "tree" ? "page" : undefined}
          onClick={() => setMobileStage("tree")}
        >
          {tr("editorview.files")}
        </button>
        <button
          type="button"
          className={mobileStage === "editor" ? "active" : ""}
          aria-current={mobileStage === "editor" ? "page" : undefined}
          disabled={activeTab === null}
          onClick={() => setMobileStage("editor")}
        >
          {activeTab?.title ?? tr("common.edit")}
        </button>
      </nav>
      <aside className="editor-tree" aria-label={tr("editorview.files")}>
        <div className="files-search">
          <input
            type="text"
            placeholder={tr("editorview.searchFiles")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search();
              else if (e.key === "Escape" && searchResults !== null) {
                e.stopPropagation();
                setSearchResults(null);
                setQuery("");
              }
            }}
          />
          <button className="small-btn icon-only" title={tr("editorview.searchFiles2")} aria-label={tr("editorview.searchFiles2")} onClick={() => void search()}><Icon.search /></button>
        </div>
        {treeErr && <div className="files-error">{treeErr}</div>}
        {searchResults !== null ? (
          <div className="files-list">
            <div className="files-actions">
              <button className="small-btn icon-only" title={tr("editorview.backToTree")} aria-label={tr("editorview.backToTree")} onClick={() => { setSearchResults(null); setQuery(""); }}><Icon.back /></button>
            </div>
            {searchResults.length === 0 && (
              <EmptyState
                title={tr("editorview.noMatches")}
                description={tr("editorview.searchFiles")}
              />
            )}
            {searchResults.map((fp) => (
              <div
                key={fp}
                className="files-row"
              >
                <button className="files-row-main" onClick={() => openFile(fp)}>
                  <span className="files-file-icon ft-icon" data-ft={fileTypeKeyOf(baseOf(fp))} aria-hidden>
                    <FileTypeGlyph type={fileTypeKeyOf(baseOf(fp))} />
                  </span>
                  <span className="files-file-name">{fp}</span>
                </button>
                <FileRowActions projectId={projectId} path={fp} onOpen={() => openFile(fp)} />
              </div>
            ))}
          </div>
        ) : (
          <>
            {rows.length === 0 && !treeErr && (
              <EmptyState
                title={tr("editorview.emptyDirectory")}
                description={tr("editorview.projectFiles")}
              />
            )}
            <div
              className="ft-tree"
              role="tree"
              aria-label={tr("editorview.projectFiles")}
              tabIndex={0}
              onKeyDown={onTreeKey}
              aria-activedescendant={sel ? treeItemId(sel) : undefined}
            >
              {rows.map(({ e, depth }) => {
                const selected = sel === e.path || activePath === e.path;
                const expanded = e.dir && open.has(e.path);
                return (
                  <div
                    key={e.path}
                    id={treeItemId(e.path)}
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-selected={selected}
                    {...(e.dir ? { "aria-expanded": open.has(e.path) } : {})}
                    className={`ft-row${e.dir ? " ft-dir" : ""}${selected ? " ft-selected" : ""}`}
                    style={{ paddingLeft: 6 + depth * 14 }}
                    draggable
                    onDragStart={(ev) => setDragPath(ev.dataTransfer, e.path)}
                    onContextMenu={(ev) => onRowContext(ev, e)}
                    onClick={() => {
                      setSel(e.path);
                      if (e.dir) toggle(e.path);
                      else openFile(e.path);
                    }}
                  >
                    <span className={`ft-chevron${expanded ? " open" : ""}`} aria-hidden>
                      {e.dir && <ChevronGlyph />}
                    </span>
                    <span
                      className={`ft-icon${expanded ? " open" : ""}`}
                      data-ft={e.dir ? "folder" : fileTypeKeyOf(e.name)}
                      aria-hidden
                    >
                      {e.dir ? <FolderGlyph /> : <FileTypeGlyph type={fileTypeKeyOf(e.name)} />}
                    </span>
                    <span className="ft-name">{e.name}</span>
                    {!e.dir && (
                      <button
                        className="ft-at"
                        title={tr("editorview.addValueToChat", { path: e.path })}
                        aria-label={tr("editorview.addValueToChat", { path: e.path })}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          attachPath(e.path);
                        }}
                      >
                        @
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </aside>

      {ctx && (
        <div className="ctx-backdrop" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }}>
          <div
            className="ctx-menu"
            role="menu"
            style={{ left: Math.min(ctx.x, window.innerWidth - 200), top: Math.min(ctx.y, window.innerHeight - 220) }}
            onClick={(e) => e.stopPropagation()}
          >
            {!ctx.entry.dir && (
              <button role="menuitem" onClick={() => { openFile(ctx.entry.path); setCtx(null); }}>{tr("common.open")}</button>
            )}
            <button role="menuitem" onClick={() => { attachPath(ctx.entry.path); setCtx(null); }}>{tr("editorview.addToChat")}</button>
            <button role="menuitem" onClick={() => { void navigator.clipboard?.writeText(ctx.entry.path); setCtx(null); }}>{tr("editorview.copyPath")}</button>
            {desktopBridge() && !project?.remote && (
              <button role="menuitem" onClick={() => { void revealNative(ctx.entry); setCtx(null); }}>
                {tr(ctx.entry.dir ? "editorview.openInFileManager" : "editorview.revealInFileManager")}
              </button>
            )}
            {ctx.entry.dir && (
              <>
                <button role="menuitem" onClick={() => { void ctxNew(ctx.entry.path, "file"); setCtx(null); }}>{tr("editorview.newFile")}</button>
                <button role="menuitem" onClick={() => { void ctxNew(ctx.entry.path, "folder"); setCtx(null); }}>{tr("editorview.newFolder")}</button>
              </>
            )}
            <button role="menuitem" onClick={() => { void ctxRename(ctx.entry); setCtx(null); }}>{tr("editorview.renameMove")}</button>
            <button role="menuitem" className="danger" onClick={() => { void ctxDelete(ctx.entry); setCtx(null); }}>{tr("editorview.delete")}</button>
          </div>
        </div>
      )}

      <PaneHost
        ref={paneRef}
        projectId={projectId}
        sessionId={sessionId}
        onActiveChange={onActiveChange}
        emptyBody={
          <div className="editor-empty">
            <EmptyState
              title={tr("editorview.selectAFileToViewOrEdit")}
              description={`${tr("editorview.enterOpensAddsToChat")} ${MOD}${tr("editorview.lSendsASelectionToTheSession")}`}
            />
          </div>
        }
      />
    </div>
  );
}
