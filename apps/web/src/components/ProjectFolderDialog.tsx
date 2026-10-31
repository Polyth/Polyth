// Full-screen folder picker (the "open project" dialog) — the one reusable
// picker for first run and every later Add/Open. A real file manager over the
// server-host /api/browse route: Home/Parent actions, a breadcrumb location
// bar that turns into a typed path on demand, an active-descendant listbox,
// and one bottom bar holding every "way to add" (new folder plus contributed
// sources) next to the primary action. Pro-only view options (hidden
// folders, go-to-path) live in the location bar's ⋯ menu.
//
// Contract: initial focus lands on the folder list — never a
// text field, so opening the picker does not summon a phone keyboard. Typing
// a path is opt-in (click the location bar, Mod+L, "/" or "~" in the list, or
// the ⋯ menu). Mod+Enter is an additive direct-confirmation shortcut; during
// Add the target and controls cannot change and Escape does not abandon the
// in-flight request; success closes only after the atomic store transition is
// observable and hands focus to the composer; cancellation restores the
// connected invoker or the named no-project recovery action — never BODY.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Dialog from "./a11y/Dialog.tsx";
import { isImeComposing } from "./input/editorCore.ts";
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
  BackIcon,
  Button,
  ChevronRightIcon,
  CloseIcon,
  EditIcon,
  HomeIcon,
  Icon,
  IconButton,
  Menu,
  MoreIcon,
  ParentFolderIcon,
  ShowIcon,
  TextInput,
} from "./ui/index.ts";

/** One clickable location-bar segment. */
interface Crumb { label: string; path: string }

/** Breadcrumb segments for an absolute host path. The home prefix collapses
 *  to "~" (the Home button sits right beside it); POSIX and Windows-style
 *  separators are both understood because the browse route is host-native. */
export function folderCrumbs(path: string, home: string): Crumb[] {
  if (!path) return [];
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  const homeTrimmed = home.length > 1 ? home.replace(/[\\/]+$/, "") : home;
  const crumbs: Crumb[] = [];
  let rest: string;
  let base: string;
  if (homeTrimmed && (trimmed === homeTrimmed || trimmed.startsWith(homeTrimmed + sep))) {
    crumbs.push({ label: "~", path: homeTrimmed });
    base = homeTrimmed;
    rest = trimmed.slice(homeTrimmed.length);
  } else if (sep === "/") {
    crumbs.push({ label: "/", path: "/" });
    base = "";
    rest = trimmed;
  } else {
    const [drive = trimmed, ...tail] = trimmed.split(sep);
    crumbs.push({ label: drive, path: `${drive}${sep}` });
    base = drive;
    rest = tail.length ? sep + tail.join(sep) : "";
  }
  for (const part of rest.split(sep).filter(Boolean)) {
    base = `${base}${sep}${part}`;
    crumbs.push({ label: part, path: base });
  }
  return crumbs;
}

/** Last path segment, for the "Open <name>" primary label. */
function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || path;
}

const TYPEAHEAD_RESET_MS = 700;

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
  onChoose,
  onBack,
  initialPath,
  confirmLabel,
  title = tr("projectfolderdialog.openAProject"),
  subtitle = tr("projectfolderdialog.chooseLocalFolder"),
}: {
  onClose: () => void;
  /** Called after the project has been added/activated. */
  onOpened?: (path: string) => void;
  /** Generic folder selection; no project creation or activation occurs. */
  onChoose?: (path: string) => Promise<void>;
  /** Multi-step hosts (project setup) offer a Back action to their previous
   *  step; the picker itself has no history beyond folder navigation. */
  onBack?: () => void;
  initialPath?: string;
  confirmLabel?: string;
  title?: string;
  subtitle?: string;
}) {
  const [path, setPath] = useState("");
  const [pathInput, setPathInput] = useState("");
  /** The location bar shows breadcrumbs until the user asks to type a path. */
  const [editingPath, setEditingPath] = useState(false);
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
  const crumbsRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef({ text: "", at: 0 });
  const editSeedRef = useRef<string | null>(null);
  const configurators = useRef(new Map<string, (projectId: string) => Promise<void>>());
  const onConfigure = useCallback((id: string, callback?: (projectId: string) => Promise<void>) => {
    if (callback) configurators.current.set(id, callback);
    else configurators.current.delete(id);
  }, []);
  const busyRef = useRef(false);
  busyRef.current = busy;
  /** Exit intent: cancellation restores the invoker/fallback; success hands
   *  focus forward and never returns it to the removed picker. */
  const outcomeRef = useRef<"cancel" | "success">("cancel");
  const announcedPathRef = useRef<string | null>(null);

  const load = useCallback(async (target?: string, showHidden?: boolean): Promise<boolean> => {
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
      return true;
    } catch (e) {
      // Browse errors keep the picker open at the last valid directory.
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [hidden]);

  useEffect(() => { void load(initialPath); /* default: home dir */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const crumbs = useMemo(() => folderCrumbs(path, home), [path, home]);
  // Deep paths keep the current folder in view: the crumb strip scrolls to
  // its end whenever the location changes.
  useLayoutEffect(() => {
    const strip = crumbsRef.current;
    if (strip) strip.scrollLeft = strip.scrollWidth;
  }, [crumbs, editingPath]);

  /** Opt-in path typing. `seed` starts a fresh absolute/home-relative path
   *  ("/" or "~" typed in the list); otherwise the current path is selected
   *  so typing replaces it. The field is focused only on this explicit
   *  request, which is what keeps the keyboard closed on open. */
  const beginPathEdit = (seed?: string) => {
    if (busy) return;
    editSeedRef.current = seed ?? null;
    setPathInput(seed ?? path);
    setEditingPath(true);
  };

  useEffect(() => {
    const input = pathInputRef.current;
    if (!editingPath || !input) return;
    input.focus();
    const seed = editSeedRef.current;
    if (seed) input.setSelectionRange(seed.length, seed.length);
    else input.select();
  }, [editingPath]);

  const endPathEdit = (refocusList: boolean) => {
    setEditingPath(false);
    setPathInput(path);
    if (refocusList) queueFocusHandoff(() => listRef.current);
  };

  const submitPathEdit = async () => {
    if (await load(pathInput.trim() || "~")) endPathEdit(true);
    else queueFocusHandoff(() => pathInputRef.current);
  };

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
      if (onChoose) {
        await onChoose(target);
        onClose();
        return;
      }
      const project = await addProject(target);
      // The POST response is authoritative; verify the atomic transition is
      // observable — the returned id exists exactly once and is active —
      // before this dialog closes.
      const s = getState();
      const occurrences = s.projectRegistry.projects.filter((p) => p.id === project.id).length;
      if (occurrences !== 1 || s.activeProjectId !== project.id) {
        throw new Error(tr("projectfolderdialog.theProjectDidnTActivatePleaseTry"));
      }
      for (const configure of configurators.current.values()) await configure(project.id);
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
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    // Typing an absolute or home-relative path starts the path editor.
    if (plain && (e.key === "/" || e.key === "~")) {
      e.preventDefault();
      beginPathEdit(e.key);
      return;
    }
    // Type-to-select: printable keys jump to the next folder whose name
    // starts with what has been typed in quick succession.
    if (plain && e.key.length === 1 && e.key !== " ") {
      const now = e.timeStamp || Date.now();
      const state = typeaheadRef.current;
      state.text = now - state.at > TYPEAHEAD_RESET_MS ? e.key : state.text + e.key;
      state.at = now;
      // Repeating one letter cycles through its matches.
      const cycling = [...state.text].every((ch) => ch === state.text[0]);
      const needle = (cycling ? e.key : state.text).toLocaleLowerCase();
      const start = selectedIndex < 0 ? 0 : selectedIndex + (cycling ? 1 : 0);
      for (let step = 0; step < entries.length; step++) {
        const index = (start + step) % entries.length;
        if (entries[index]?.name.toLocaleLowerCase().startsWith(needle)) {
          e.preventDefault();
          selectIndex(index);
          return;
        }
      }
      return;
    }
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
      return;
    }
    // Mod+L: the file-manager "go to location" shortcut.
    if ((e.key === "l" || e.key === "L") && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      beginPathEdit();
    }
  };

  const target = selected ?? path;
  const primaryLabel = busy
    ? tr("projectfolderdialog.opening")
    : confirmLabel ?? (target ? tr("projectfolderdialog.openNamed", { name: folderName(target) }) : tr("projectfolderdialog.openProject"));

  // Pro-only view options stay one tap away instead of crowding the bar.
  const optionsMenu = (
    <Menu
      label={tr("projectfolderdialog.moreOptions")}
      align="end"
      entries={[
        { id: "go-to-path", label: tr("projectfolderdialog.goToPath"), icon: EditIcon, detail: `${MOD} L`, disabled: busy, onSelect: () => beginPathEdit() },
        "separator",
        { id: "show-hidden", label: tr("projectfolderdialog.showHiddenFolders"), icon: ShowIcon, kind: "switch", checked: hidden, disabled: busy, onSelect: toggleHidden },
      ]}
    >
      {(trigger) => (
        <IconButton
          {...trigger}
          icon={MoreIcon}
          variant="quiet"
          className="folder-options"
          data-active={hidden || undefined}
          label={tr("projectfolderdialog.moreOptions")}
          disabled={busy}
        />
      )}
    </Menu>
  );

  return (
    <Dialog
      title={title}
      onClose={requestClose}
      size="lg"
      className="folder-dialog"
      initialFocus=".folder-list"
      resolveRestoreFocus={resolveRestoreFocus}
    >
      <div
        className="folder-dialog-body"
        data-source-armed={armedSource?.id}
        onKeyDown={onDialogKeyDown}
      >
        <div className="folder-dialog-head">
          {onBack && (
            <IconButton icon={BackIcon} variant="quiet" className="folder-back" label={tr("common.back")} disabled={busy} onClick={onBack} />
          )}
          <div className="folder-dialog-heading">
            <div className="folder-dialog-title">{title}</div>
            <div className="folder-dialog-subtitle">{subtitle}</div>
          </div>
          <IconButton icon={CloseIcon} label={tr("common.close")} disabled={busy} onClick={requestClose} />
        </div>

        {/* A `solo` alternative source (e.g. SSH) drives its own browser, so
            the shared local file manager steps aside while it is open. */}
        {!armedSource?.solo && (
          <>
            <div className="folder-toolbar folder-location">
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
              {editingPath ? (
                <TextInput
                  ref={pathInputRef}
                  uiSize="sm"
                  className="folder-path mono"
                  value={pathInput}
                  aria-label={tr("projectfolderdialog.currentPath")}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  enterKeyHint="go"
                  disabled={busy}
                  onChange={(e) => setPathInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (isImeComposing(e)) return;
                    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault();
                      void submitPathEdit();
                    }
                  }}
                  // Escape leaves path typing, not the dialog. The Dialog's
                  // own Escape listener sits on the panel and would see the
                  // bubbling event first, so this claims it while capturing.
                  onKeyDownCapture={(e) => {
                    if (isImeComposing(e)) return;
                    if (e.key !== "Escape") return;
                    e.preventDefault();
                    e.stopPropagation();
                    endPathEdit(true);
                  }}
                  onBlur={() => endPathEdit(false)}
                />
              ) : (
                <nav className="folder-crumbs" aria-label={tr("projectfolderdialog.currentPath")}>
                  <div ref={crumbsRef} className="folder-crumbs-strip">
                    {crumbs.map((crumb, index) => {
                      const last = index === crumbs.length - 1;
                      return (
                        <span key={crumb.path} className="folder-crumb-item">
                          {index > 0 && <span className="folder-crumb-sep" aria-hidden="true">/</span>}
                          <button
                            type="button"
                            className="folder-crumb"
                            aria-current={last ? "location" : undefined}
                            title={crumb.path}
                            disabled={busy}
                            onClick={() => (last ? beginPathEdit() : void load(crumb.path))}
                          >
                            <bdi>{crumb.label}</bdi>
                          </button>
                        </span>
                      );
                    })}
                  </div>
                  {/* The empty end of the bar behaves like a file manager's
                      address bar: clicking it switches to typing a path. The
                      ⋯ menu and Mod+L are the keyboard-reachable equivalents. */}
                  <button
                    type="button"
                    className="folder-crumbs-edit"
                    tabIndex={-1}
                    aria-label={tr("projectfolderdialog.goToPath")}
                    title={tr("projectfolderdialog.goToPath")}
                    disabled={busy}
                    onClick={() => beginPathEdit()}
                  />
                </nav>
              )}
              {optionsMenu}
            </div>

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
                  <span className="folder-row-meta">{entry.modifiedAt ? tr("projectfolderdialog.valueAgo", { value: ago(entry.modifiedAt) }) : ""}</span>
                  <span className="folder-row-enter" aria-hidden="true"><Icon icon={ChevronRightIcon} size="sm" /></span>
                </div>
              ))}
              {entries.length === 0 && !error && <div className="folder-empty">{tr("projectfolderdialog.noSubFoldersHereOpenThisFolder")}</div>}
            </div>
          </>
        )}

        {!armedSource && error && <div ref={errorRef} tabIndex={-1} className="form-error folder-error" role="alert">{error}</div>}

        {/* One bottom bar: every "way to add" — New folder plus contributed
            alternative sources (SSH, clone…) — on the start side, the primary
            action on the end side. A source reveals its fields inline below
            the chips and owns the primary action while open. */}
        <div className="folder-foot">
          <div className="folder-source-row">
            {creating ? (
              <span className="folder-newname">
                <TextInput
                  autoFocus
                  uiSize="sm"
                  value={newName}
                  placeholder={tr("projectfolderdialog.newFolderName2")}
                  aria-label={tr("projectfolderdialog.newFolderName")}
                  spellCheck={false}
                  autoCapitalize="off"
                  disabled={busy}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (isImeComposing(e)) return;
                    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) void createFolder();
                  }}
                  // Escape cancels only this sub-operation, not the dialog
                  // (claimed while capturing, as for the path field).
                  onKeyDownCapture={(e) => {
                    if (isImeComposing(e)) return;
                    if (e.key !== "Escape") return;
                    e.preventDefault();
                    e.stopPropagation();
                    setCreating(false);
                  }}
                />
                <Button size="sm" disabled={busy || !newName.trim()} onClick={() => void createFolder()}>
                  {tr("common.create")}
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                className="ghost-link folder-source-chip folder-new-folder"
                iconStart={AddIcon}
                disabled={busy}
                onClick={() => { setArmedSource(null); setCreating(true); }}
              >
                {tr("projectfolderdialog.newFolder")}
              </Button>
            )}
            {!onChoose && <SlotHost
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
                onConfigure,
              }}
            />}
          </div>

          {/* The local primary action steps aside while an alternative source
              is open — that panel carries its own confirm button. */}
          {!armedSource && (
            <Button
              size="sm"
              variant="primary"
              className="folder-open-btn"
              title={target ? `${target} · ${MOD} ↵` : undefined}
              disabled={busy || (!selected && !path)}
              aria-busy={busy || undefined}
              onClick={() => void openProject()}
            >
              {primaryLabel}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
