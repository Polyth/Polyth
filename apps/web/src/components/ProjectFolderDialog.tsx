// Full-screen folder picker (the "open project" dialog) — the one reusable
// picker for first run and every later Add/Open. A real file manager over the
// server-host /api/browse route: labelled path input, Home/Parent actions,
// an active-descendant listbox, hidden toggle, optional new-folder creation.
//
// UX-ONBOARDING contract: initial focus lands on the path input with its text
// selected; Mod+Enter is an additive direct-confirmation shortcut; during Add
// the target and controls cannot change and Escape does not abandon the
// in-flight request; success closes only after the atomic store transition is
// observable and hands focus to the composer; cancellation restores the
// connected invoker or the named no-project recovery action — never BODY.
import { useCallback, useEffect, useRef, useState } from "react";
import Dialog from "./a11y/Dialog.tsx";
import SlotHost from "./slots/SlotHost.ts";
import { announce } from "./a11y/live.tsx";
import { api, type BrowseEntryDto } from "@polyth/session/web-api";
import { addProject } from "../init.ts";
import { COMPOSER_INPUT_SELECTOR, focusComposer, getState } from "../store.ts";
import { ago, MOD } from "../format.ts";
import { tr } from "../i18n/index.ts";
import { errorFeedback, successFeedback, tapFeedback } from "../haptics.ts";
import {
  AddIcon,
  Button,
  CloseIcon,
  HomeIcon,
  IconButton,
  ParentFolderIcon,
  Switch,
  TextInput,
} from "./ui/index.ts";

const folderIcon = (
  <svg className="ui-icon ui-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6.5h7l2 2h9v10H3z" />
  </svg>
);

/** Layout-safe queued focus: retry across frames until the destination has
 *  mounted and committed, instead of focusing a component that isn't there. */
function queueFocusHandoff(select: () => HTMLElement | null, attempts = 24): void {
  const tick = (left: number) => {
    const el = select();
    if (el) {
      el.focus();
      return;
    }
    if (left > 0) requestAnimationFrame(() => tick(left - 1));
  };
  requestAnimationFrame(() => tick(attempts));
}

/** After successful activation, hand focus to the composer immediately. */
function focusAfterActivation(): void {
  focusComposer();
}

export default function ProjectFolderDialog({
  onClose,
  onOpened,
  title = tr("projectfolderdialog.openAProject"),
  subtitle = tr("projectfolderdialog.chooseLocalFolder"),
}: {
  onClose: () => void;
  /** Called after the project has been added/activated. */
  onOpened?: (path: string) => void;
  title?: string;
  subtitle?: string;
}) {
  const [path, setPath] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [home, setHome] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntryDto[]>([]);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  /** An alternative project source (SSH, clone…) contributed to
   *  `project.create.options` is disclosed inline. `solo` sources drive their
   *  own browser and hide the shared local one. Only one is open at a time and
   *  it, not the local flow, owns the primary action while open. */
  const [armedSource, setArmedSource] = useState<{ id: string; solo: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;
  /** Exit intent: cancellation restores the invoker/fallback; success hands
   *  focus forward and never returns it to the removed picker. */
  const outcomeRef = useRef<"cancel" | "success">("cancel");
  const announcedPathRef = useRef<string | null>(null);
  const initialSelectDoneRef = useRef(false);

  const load = useCallback(async (target?: string, showHidden?: boolean) => {
    try {
      setError("");
      const r = await api.browseHost(target, showHidden ?? hidden);
      setPath(r.path);
      setPathInput(r.path);
      setHome(r.home);
      setParent(r.parent);
      setEntries(r.entries);
      setSelected(null);
      // Directory changes announce the canonical current path politely.
      if (announcedPathRef.current !== null && announcedPathRef.current !== r.path) {
        announce(tr("projectfolderdialog.currentFolderValue", { path: r.path }));
      }
      announcedPathRef.current = r.path;
    } catch (e) {
      // Browse errors keep the picker open at the last valid directory.
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [hidden]);

  useEffect(() => { void load(); /* default: home dir */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial focus: the current-path input with its text selected, so an
  // absolute path can be typed immediately (the Dialog focuses the input;
  // selection happens once the canonical path arrives).
  useEffect(() => {
    if (initialSelectDoneRef.current || path === "") return;
    initialSelectDoneRef.current = true;
    if (document.activeElement === pathInputRef.current) pathInputRef.current?.select();
  }, [path]);

  /** Close requests are ignored while an Add is in flight — Escape, the Close
   *  button, and backdrop dismissal never abandon the request. */
  const requestClose = () => {
    if (busyRef.current) return;
    outcomeRef.current = "cancel";
    onClose();
  };

  /** Cancellation focus: the connected invoker, else the named no-project
   *  `Choose a folder…` action (automatic first run has no invoker), else the
   *  sidebar recovery action or the composer. Never BODY. On success the
   *  queued handoff owns focus instead. */
  const resolveRestoreFocus = (opener: HTMLElement | null): HTMLElement | null => {
    if (outcomeRef.current === "success") return null;
    if (opener && opener.isConnected) return opener;
    return (
      document.querySelector<HTMLElement>(".hero-open-project")
      ?? document.querySelector<HTMLElement>(".sidebar .empty-state-action, .sidebar-add-project")
      ?? document.querySelector<HTMLElement>(COMPOSER_INPUT_SELECTOR)
    );
  };

  const toggleHidden = () => {
    if (busy) return;
    const next = !hidden;
    setHidden(next);
    announce(next ? tr("projectfolderdialog.hiddenFoldersShown") : tr("projectfolderdialog.hiddenFoldersHidden"));
    void load(path, next);
  };

  const enter = (entry: BrowseEntryDto) => {
    if (busy) return;
    if (window.matchMedia?.("(pointer: coarse)").matches) tapFeedback();
    void load(entry.path);
  };

  const openProject = async () => {
    const target = selected ?? path;
    if (!target || busy) return;
    setBusy(true);
    setError("");
    try {
      const project = await addProject(target);
      // The POST response is authoritative; verify the atomic transition is
      // observable — the returned id exists exactly once and is active —
      // before this dialog closes.
      const s = getState();
      const occurrences = s.projectRegistry.projects.filter((p) => p.id === project.id).length;
      if (occurrences !== 1 || s.activeProjectId !== project.id) {
        throw new Error(tr("projectfolderdialog.theProjectDidnTActivatePleaseTry"));
      }
      outcomeRef.current = "success";
      successFeedback();
      announce(tr("projectfolderdialog.openedValue", { value: project.name || project.path }));
      onOpened?.(target);
      onClose();
      focusAfterActivation();
    } catch (e) {
      // Failure restores interaction with path/selection intact and moves
      // focus to the alert; Retry submits the same target exactly once.
      setError(e instanceof Error ? e.message : String(e));
      errorFeedback();
      queueFocusHandoff(() => errorRef.current);
    } finally {
      setBusy(false);
    }
  };

  /** Success completion for alternative project sources contributed through
   *  the `project.create.options` slot (e.g. SSH remotes): the source already
   *  created and activated the project, so the picker closes with success
   *  semantics and hands focus forward exactly like a local open. */
  const completeExternally = () => {
    outcomeRef.current = "success";
    onOpened?.(getState().projectRegistry.projects.find((p) => p.id === getState().activeProjectId)?.path ?? "");
    onClose();
    focusAfterActivation();
  };

  const createFolder = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError("");
    try {
      const target = `${path.replace(/\/$/, "")}/${name}`;
      await api.browseMkdir(target);
      setCreating(false);
      setNewName("");
      await load(path);
      setSelected(target);
      successFeedback();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      errorFeedback();
    } finally {
      setBusy(false);
    }
  };

  // ---- active-descendant listbox ------------------------------------------------
  // The listbox keeps DOM focus; the selected row is exposed through
  // aria-activedescendant on stable per-row DOM ids.
  const optionId = (index: number) => `folder-option-${index}`;
  const selectedIndex = entries.findIndex((x) => x.path === selected);
  const activeDescendant = selectedIndex >= 0 ? optionId(selectedIndex) : undefined;

  const selectIndex = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    setSelected(entry.path);
    document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (busy) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const current = entries[selectedIndex];
      if (current) enter(current);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    if (entries.length === 0) return;
    if (e.key === "Home") return selectIndex(0);
    if (e.key === "End") return selectIndex(entries.length - 1);
    if (e.key === "ArrowDown") return selectIndex(selectedIndex < 0 ? 0 : Math.min(entries.length - 1, selectedIndex + 1));
    return selectIndex(selectedIndex < 0 ? 0 : Math.max(0, selectedIndex - 1));
  };

  // Mod+Enter (Ctrl+Enter / ⌘Enter) is an additive direct-confirm shortcut —
  // it never replaces the primary button, which stays in normal Tab order.
  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    // While an alternative source owns the flow, its own panel confirms.
    if (armedSource) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      void openProject();
    }
  };

  return (
    <Dialog
      title={title}
      onClose={requestClose}
      size="lg"
      className="folder-dialog"
      initialFocus=".folder-path"
      resolveRestoreFocus={resolveRestoreFocus}
    >
      <div
        className="folder-dialog-body"
        data-source-armed={armedSource?.id}
        onKeyDown={onDialogKeyDown}
      >
        <div className="folder-dialog-head">
          <div>
            <div className="folder-dialog-title">{title}</div>
            <div className="folder-dialog-subtitle">{subtitle}</div>
          </div>
          <IconButton icon={CloseIcon} label={tr("common.close")} disabled={busy} onClick={requestClose} />
        </div>

        {/* A `solo` alternative source (e.g. SSH) drives its own browser, so
            the shared local file manager steps aside while it is open. */}
        {!armedSource?.solo && (
          <>
            <div className="folder-toolbar">
              <IconButton
                icon={HomeIcon}
                variant="quiet"
                label={tr("projectfolderdialog.goToHomeDirectory")}
                title={tr("projectfolderdialog.homeDirectory")}
                disabled={busy}
                onClick={() => void load(home || "~")}
              />
              <IconButton
                icon={ParentFolderIcon}
                variant="quiet"
                label={tr("projectfolderdialog.goToParentFolder")}
                title={tr("projectfolderdialog.parentFolder")}
                disabled={busy || !parent}
                onClick={() => parent && void load(parent)}
              />
              <TextInput
                ref={pathInputRef}
                uiSize="sm"
                className="folder-path mono"
                value={pathInput}
                aria-label={tr("projectfolderdialog.currentPath")}
                spellCheck={false}
                disabled={busy}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) void load(pathInput.trim() || "~");
                }}
                onBlur={() => setPathInput(path)}
              />
              <span className="folder-hidden-toggle">
                <span>{tr("projectfolderdialog.hidden")}</span>
                <Switch
                  checked={hidden}
                  label={tr("projectfolderdialog.hidden")}
                  disabled={busy}
                  onChange={toggleHidden}
                />
              </span>
            </div>

            <div className="folder-cols" aria-hidden="true"><span>{tr("projectfolderdialog.name")}</span><span>{tr("projectfolderdialog.modified")}</span></div>

            {/* The Parent row is a named navigation action, not a false listbox option. */}
            {parent && (
              <button
                type="button"
                className="folder-row folder-up folder-up-action"
                aria-label={tr("projectfolderdialog.openParentFolder")}
                disabled={busy}
                onClick={() => void load(parent)}
              >
                <span className="folder-row-icon">{folderIcon}</span>
                <span className="folder-row-name mono">..</span>
                <span className="folder-row-meta" />
              </button>
            )}

            <div
              ref={listRef}
              className="folder-list"
              role="listbox"
              aria-label={tr("projectfolderdialog.folders")}
              tabIndex={0}
              aria-activedescendant={activeDescendant}
              aria-busy={busy || undefined}
              onKeyDown={onListKeyDown}
            >
              {entries.map((entry, index) => (
                <div
                  key={entry.path}
                  id={optionId(index)}
                  data-path={entry.path}
                  className={`folder-row ${selected === entry.path ? "selected" : ""}`}
                  role="option"
                  aria-selected={selected === entry.path}
                  onClick={() => {
                    if (busy) return;
                    if (window.matchMedia?.("(pointer: coarse)").matches) {
                      enter(entry);
                      return;
                    }
                    setSelected(entry.path);
                    listRef.current?.focus();
                  }}
                  onDoubleClick={() => enter(entry)}
                >
                  <span className="folder-row-icon">{folderIcon}</span>
                  <span className="folder-row-name">{entry.name}</span>
                  <span className="folder-row-meta mono">{entry.modifiedAt ? tr("projectfolderdialog.valueAgo", { value: ago(entry.modifiedAt) }) : ""}</span>
                  <span className="folder-row-enter" aria-hidden="true">{tr("projectfolderdialog.enterFolder")} <span>›</span></span>
                </div>
              ))}
              {entries.length === 0 && !error && <div className="folder-empty">{tr("projectfolderdialog.noSubFoldersHereOpenThisFolder")}</div>}
            </div>
          </>
        )}

        {!armedSource?.solo && (
          <div className="folder-legend">
            <span className="legend-item"><span className="kbd">↑</span><span className="kbd">↓</span> {tr("projectfolderdialog.navigate")}</span>
            <span className="legend-item"><span className="kbd">↵</span> {tr("projectfolderdialog.enterFolder")}</span>
            {!armedSource && <span className="legend-item"><span className="kbd">{MOD} ↵</span> {tr("projectfolderdialog.openProject2")}</span>}
            <span className="legend-item"><span className="kbd">{tr("projectfolderdialog.esc")}</span> {tr("projectfolderdialog.close")}</span>
          </div>
        )}

        {!armedSource && error && <div ref={errorRef} tabIndex={-1} className="form-error folder-error" role="alert">{error}</div>}

        {/* "Ways to add" — New folder plus every contributed alternative source
            (SSH, clone…). Each reveals its extra fields inline; only one is
            open at a time and it owns the primary action while open. */}
        <div className="folder-sources">
          <div className="folder-source-row">
            {creating ? (
              <span className="folder-newname">
                <TextInput
                  autoFocus
                  uiSize="sm"
                  value={newName}
                  placeholder={tr("projectfolderdialog.newFolderName2")}
                  aria-label={tr("projectfolderdialog.newFolderName")}
                  disabled={busy}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) void createFolder();
                    // Escape cancels only this sub-operation, not the dialog.
                    else if (e.key === "Escape") { e.stopPropagation(); setCreating(false); }
                  }}
                />
                <Button size="sm" disabled={busy || !newName.trim()} onClick={() => void createFolder()}>
                  {tr("common.create")}
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                className="ghost-link folder-source-chip"
                iconStart={AddIcon}
                disabled={busy}
                onClick={() => { setArmedSource(null); setCreating(true); }}
              >
                {tr("projectfolderdialog.newFolder")}
              </Button>
            )}
            <SlotHost
              slot="project.create.options"
              context={{
                busy,
                browsedPath: selected ?? path,
                armedId: armedSource?.id ?? null,
                arm: (id: string, opts?: { soloBrowser?: boolean }) => {
                  setCreating(false);
                  setError("");
                  setArmedSource({ id, solo: opts?.soloBrowser === true });
                },
                // Guarded: a source releasing on unmount/collapse must not
                // clear a *different* source that armed itself in between.
                disarm: (id: string) => setArmedSource((cur) => (cur && cur.id === id ? null : cur)),
                onProjectOpened: completeExternally,
              }}
            />
          </div>
        </div>

        {/* The local primary action steps aside while an alternative source is
            open — that panel carries its own confirm button in the same spot. */}
        {!armedSource && (
          <div className="folder-foot">
            <span className="header-spacer" />
            <span className="folder-selected mono" title={selected ?? path}>{selected ?? path}</span>
            <Button
              size="sm"
              variant="primary"
              className="folder-open-btn"
              disabled={busy || (!selected && !path)}
              aria-busy={busy || undefined}
              onClick={() => void openProject()}
            >
              {busy ? tr("projectfolderdialog.opening") : tr("projectfolderdialog.openProject")}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
