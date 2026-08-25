// UX-COMPOSER-DISC: the persistent `Add` trigger and its discovery menu.
// Names real outcomes first, shows sigils only as secondary expert hints, and
// projects the four-state capability truth supplied by the Composer. This
// component owns no parser, no send path, and appends no session event —
// every activation delegates to an existing composer seam.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { addMenuRows, type AddMenuAction, type CatalogState } from "../composer/discovery.ts";
import type { SlashCommand, SnippetDef } from "../api.ts";
import { parseGithubUrl, type GithubAttachResult } from "../attachments.ts";
import { useEscape } from "../useEscape.ts";
import Dialog from "./a11y/Dialog.tsx";
import { Icon } from "../icons.tsx";
import { tr } from "../i18n/index.ts";

export interface ComposerAddMenuProps {
  hasProject: boolean;
  hasSession: boolean;
  goalsEnabled: boolean;
  draftText: string;
  commands: CatalogState<SlashCommand>;
  snippets: CatalogState<SnippetDef>;
  /** Menu opens upward from the docked composer, downward from the hero. */
  direction: "up" | "down";
  /** UX-MOBILE-01 §17/§19: on phones this IS the single `+` control — the
   *  separate upload chip is not rendered, so `+` and `⋮` never sit side by
   *  side as two abstract menus. */
  trigger?: "tools" | "add";
  onUpload: () => void;
  onInsertMention: () => void;
  onInsertCommand: () => void;
  onInsertSnippet: () => void;
  onEnterShell: () => void;
  onAttachGoal: () => void;
  /** Link-only GitHub attach; the dialog reports each failure verbatim. */
  attachGithub: (url: string) => Promise<GithubAttachResult>;
}

export default function ComposerAddMenu(props: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeToTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  useEscape(open && !githubOpen, closeToTrigger);

  // Opening focuses the first operable row (menu button pattern).
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']:not([aria-disabled='true'])");
    first?.focus();
  }, [open]);

  const rows = addMenuRows({
    hasProject: props.hasProject,
    hasSession: props.hasSession,
    goalsEnabled: props.goalsEnabled,
    draftText: props.draftText,
    commands: props.commands,
    snippets: props.snippets,
  });

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

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
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

  return (
    <span className="composer-add">
      <button
        ref={triggerRef}
        type="button"
        className="chip composer-add-trigger"
        aria-label={props.trigger === "add" ? tr("composeraddmenu.addFilesContextAndTools") : tr("composeraddmenu.moreComposerTools")}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(open ? { "aria-controls": "composer-add-menu" } : {})}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true" className="composer-add-icon">
          {props.trigger === "add" ? <Icon.plus /> : <Icon.more />}
        </span>
        <span className="composer-add-label">{props.trigger === "add" ? tr("common.add") : tr("composeraddmenu.tools")}</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={closeToTrigger} />
          <div
            id="composer-add-menu"
            ref={menuRef}
            role="menu"
            aria-label={tr("composeraddmenu.addContextOrUseAComposerTool")}
            className={`add-menu ${props.direction}`}
            onKeyDown={onMenuKey}
          >
            {rows.map((row) => row.kind === "group" ? (
              <div key={row.id} className="add-menu-group" role="presentation">{row.label}</div>
            ) : (
              <button
                key={row.id}
                type="button"
                role="menuitem"
                className="add-menu-item"
                aria-disabled={row.disabledReason ? true : undefined}
                onClick={() => { if (!row.disabledReason && row.action) activate(row.action); }}
              >
                <span className="add-menu-main">
                  <span className="add-menu-label">{row.label}</span>
                  {row.description && <span className="add-menu-desc">{row.description}</span>}
                  {row.detail && <span className="add-menu-desc">{row.detail}</span>}
                  {row.disabledReason && <span className="add-menu-reason">{row.disabledReason}</span>}
                </span>
                {row.hint && <span className="add-menu-hint" aria-hidden="true">{row.hint}</span>}
              </button>
            ))}
          </div>
        </>
      )}
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
    <Dialog title={tr("composeraddmenu.linkGithubIssueOrPullRequest")} onClose={onClose} className="github-link-dialog" initialFocus="input">
      <h3 className="github-link-title">{tr("composeraddmenu.linkGithubIssueOrPullRequest")}</h3>
      <p className="github-link-copy">
        {tr("composeraddmenu.polythAddsAReferenceToTheMatching")}</p>
      <input
        type="url"
        placeholder={tr("composeraddmenu.httpsGithubComOwnerRepoIssues123")}
        value={url}
        onChange={(e) => { setUrl(e.target.value); setError(""); }}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
        aria-label={tr("composeraddmenu.githubIssueOrPullRequestUrl")}
      />
      {error && <div className="github-link-error" role="alert">{error}</div>}
      <div className="github-link-actions">
        <button type="button" className="small-btn" onClick={onClose}>{tr("common.cancel")}</button>
        <button
          type="button"
          className="primary-btn"
          disabled={!valid || busy}
          onClick={() => void submit()}
        >
          {tr("composeraddmenu.addLink")}</button>
      </div>
    </Dialog>
  );
}
