// UX-COMPOSER-DISC: the persistent `Add` trigger and its discovery surface.
// The compact composer stays writing-first; this menu owns attachments,
// context and compose utilities. Quick actions accelerate common outcomes but
// never replace the labelled source-of-truth rows below them.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  addMenuRows,
  type AddMenuAction,
  type AddMenuRow,
  type CatalogState,
  type ComposerCommand,
} from "../composer/discovery.ts";
import type { SnippetDef } from "@polyth/session/web-api";
import { parseGithubUrl, type GithubAttachResult } from "@polyth/github/attachments";
import { tr } from "../i18n/index.ts";
import { useShellMode } from "../responsiveShell.ts";
import { dismissKeyboard } from "../mobileViewport.ts";
import Sheet from "./mobile/Sheet.tsx";
import { useSheetTrigger } from "./mobile/sheetTrigger.ts";
import { useDismissibleMenu } from "./a11y/Menu.ts";
import {
  Button,
  ChevronRightIcon,
  Dialog,
  FileIcon,
  PlusIcon,
  PullRequestIcon,
  SettingsIcon,
  TargetIcon,
  TextInput,
  UploadIcon,
  type LucideIcon,
} from "./ui/index.ts";

export interface ComposerAddMenuProps {
  hasProject: boolean;
  hasSession: boolean;
  goalsEnabled: boolean;
  draftText: string;
  commands: CatalogState<ComposerCommand>;
  snippets: CatalogState<SnippetDef>;
  uploadDisabledReason?: string;
  /** Menu opens upward from the docked composer, downward from the hero. */
  direction: "up" | "down";
  onUpload: () => void;
  onInsertMention: () => void;
  onInsertCommand: () => void;
  onInsertSnippet: () => void;
  onEnterShell: () => void;
  onAttachGoal: () => void;
  /** Opens the broader harness/tool configuration surface. */
  onMoreControls: () => void;
  /** Link-only GitHub attach; the dialog reports each failure verbatim. */
  attachGithub: (url: string) => Promise<GithubAttachResult>;
}

type QuickAction = {
  row: AddMenuRow;
  label: string;
  icon: LucideIcon;
};

export default function ComposerAddMenu(props: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const asSheet = useShellMode() === "phone";

  const closeToTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const onMenuKeyDown = useDismissibleMenu({
    open: open && !asSheet,
    menuRef,
    triggerRef,
    onClose: () => setOpen(false),
  });

  const toggleOpen = () => {
    if (open) {
      closeToTrigger();
      return;
    }
    setOpen(true);
    // A phone action list is a modal Sheet. Dismiss the keyboard after it is
    // mounted so the trigger's pointer-up cannot be lost during reflow.
    if (asSheet) void dismissKeyboard();
  };
  const triggerHandlers = useSheetTrigger(asSheet, toggleOpen);

  // Opening focuses the first operable quick action / row on desktop.
  useEffect(() => {
    if (!open || asSheet) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      "button[role='menuitem']:not([aria-disabled='true'])",
    );
    first?.focus();
  }, [open, asSheet]);

  const rows = addMenuRows({
    hasProject: props.hasProject,
    hasSession: props.hasSession,
    goalsEnabled: props.goalsEnabled,
    draftText: props.draftText,
    commands: props.commands,
    snippets: props.snippets,
    ...(props.uploadDisabledReason ? { uploadDisabledReason: props.uploadDisabledReason } : {}),
  });
  const itemById = new Map(
    rows.flatMap((row) => row.kind === "item" ? [[row.id, row] as const] : []),
  );

  const activate = (action: AddMenuAction) => {
    // Selection closes the menu; focus moves to the resulting target (the
    // editor, the file picker, or the opened dialog) — not back to Add.
    setOpen(false);
    switch (action) {
      case "upload": props.onUpload(); break;
      case "mention": props.onInsertMention(); break;
      case "github": setGithubOpen(true); break;
      case "goal": props.onAttachGoal(); break;
      case "commands": props.onInsertCommand(); break;
      case "snippets": props.onInsertSnippet(); break;
      case "shell": props.onEnterShell(); break;
    }
  };

  const activateRow = (row: AddMenuRow) => {
    if (row.kind !== "item" || row.disabledReason || !row.action) return;
    activate(row.action);
  };

  const quickActions: QuickAction[] = [
    { id: "upload", label: tr("composer.files"), icon: UploadIcon },
    { id: "mention", label: tr("composer.files2"), icon: FileIcon },
    { id: "github", label: "GitHub", icon: PullRequestIcon },
    { id: "goal", label: tr("composer.discovery.attachGoal"), icon: TargetIcon },
  ].flatMap(({ id, label, icon }) => {
    const row = itemById.get(id);
    return row ? [{ row, label, icon }] : [];
  });

  // Sheets retain the existing in-list arrow handling; desktop delegates to
  // the shared menu primitive for the complete dismissal/navigation contract.
  const onSheetMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']") ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown"
      ? items[(at + 1) % items.length]
      : items[(at - 1 + items.length) % items.length];
    next?.focus();
  };

  const menuRows = (
    <div
      id="composer-add-menu"
      ref={menuRef}
      role="menu"
      aria-label={tr("composeraddmenu.addContextOrUseAComposerTool")}
      className={`add-menu add-menu-v2 ${asSheet ? "add-menu-sheet-list" : props.direction}`}
      onKeyDown={asSheet ? onSheetMenuKey : onMenuKeyDown}
    >
      {quickActions.length > 0 && (
        <div className="add-menu-quick" role="group" aria-label={tr("composeraddmenu.addFilesContextAndTools")}>
          {quickActions.map(({ row, label, icon: QuickIcon }) => (
            <button
              key={`quick-${row.id}`}
              type="button"
              role="menuitem"
              className="add-menu-quick-action"
              aria-disabled={row.disabledReason ? true : undefined}
              aria-label={row.disabledReason ? `${label}. ${row.disabledReason}` : label}
              title={row.disabledReason ?? row.label}
              onClick={() => activateRow(row)}
            >
              <span className="add-menu-quick-icon" aria-hidden="true"><QuickIcon /></span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="add-menu-sections">
        {rows.map((row) => row.kind === "group" ? (
          <div key={row.id} className="add-menu-group" role="presentation">{row.label}</div>
        ) : (
          <button
            key={row.id}
            type="button"
            role="menuitem"
            className="add-menu-item"
            aria-disabled={row.disabledReason ? true : undefined}
            onClick={() => activateRow(row)}
          >
            <span className="add-menu-main">
              <span className="add-menu-label">{row.label}</span>
              {row.description && <span className="add-menu-desc">{row.description}</span>}
              {row.disabledReason && <span className="add-menu-reason">{row.disabledReason}</span>}
            </span>
            {(row.detail || row.hint) && (
              <span className="add-menu-meta">
                {row.detail && <span className="add-menu-detail">{row.detail}</span>}
                {row.hint && <span className="add-menu-hint" aria-hidden="true">{row.hint}</span>}
              </span>
            )}
          </button>
        ))}

        <div className="add-menu-group add-menu-tools-group" role="presentation">
          {tr("composeraddmenu.tools")}
        </div>
        <button
          type="button"
          role="menuitem"
          className="add-menu-item add-menu-more"
          onClick={() => {
            setOpen(false);
            props.onMoreControls();
          }}
        >
          <span className="add-menu-more-icon" aria-hidden="true"><SettingsIcon /></span>
          <span className="add-menu-main">
            <span className="add-menu-label">{tr("composeraddmenu.moreComposerTools")}</span>
          </span>
          <span className="add-menu-more-arrow" aria-hidden="true"><ChevronRightIcon /></span>
        </button>
      </div>
    </div>
  );

  return (
    <span className="composer-add">
      <button
        ref={triggerRef}
        type="button"
        className="chip composer-add-trigger"
        aria-label={tr("composeraddmenu.addFilesContextAndTools")}
        aria-haspopup={asSheet ? "dialog" : "menu"}
        aria-expanded={open}
        {...(open && !asSheet ? { "aria-controls": "composer-add-menu" } : {})}
        {...triggerHandlers}
      >
        <span aria-hidden="true" className="composer-add-icon"><PlusIcon /></span>
        <span className="composer-add-label">{tr("common.add")}</span>
      </button>
      {open && asSheet && (
        <Sheet
          title={tr("common.add")}
          className="composer-add-sheet"
          onClose={closeToTrigger}
          restoreFocusRef={triggerRef}
        >
          {menuRows}
        </Sheet>
      )}
      {open && !asSheet && menuRows}
      {githubOpen && (
        <GithubLinkDialog
          attachGithub={props.attachGithub}
          onClose={() => { setGithubOpen(false); triggerRef.current?.focus(); }}
        />
      )}
    </span>
  );
}

function GithubLinkDialog({ attachGithub, onClose }: {
  attachGithub: (url: string) => Promise<GithubAttachResult>;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const valid = parseGithubUrl(url) !== null;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    const r = await attachGithub(url.trim());
    setBusy(false);
    if (r.ok) {
      onClose();
      return;
    }
    // Failure creates no pill, preserves the input, and reports a bounded
    // inline error.
    setError(r.reason.length > 300 ? `${r.reason.slice(0, 297)}…` : r.reason);
  };

  return (
    <Dialog
      title={tr("composeraddmenu.linkGithubIssueOrPullRequest")}
      onClose={onClose}
      className="github-link-dialog"
      initialFocus="input"
      footer={(
        <>
          <Button size="sm" onClick={onClose}>{tr("common.cancel")}</Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!valid || busy}
            onClick={() => void submit()}
          >
            {tr("composeraddmenu.addLink")}
          </Button>
        </>
      )}
    >
      <p className="github-link-copy">
        {tr("composeraddmenu.polythAddsAReferenceToTheMatching")}</p>
      <TextInput
        type="url"
        placeholder={tr("composeraddmenu.httpsGithubComOwnerRepoIssues123")}
        value={url}
        onChange={(e) => { setUrl(e.target.value); setError(""); }}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
        aria-label={tr("composeraddmenu.githubIssueOrPullRequestUrl")}
      />
      {error && <div className="github-link-error" role="alert">{error}</div>}
    </Dialog>
  );
}
