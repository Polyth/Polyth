// Unified palette (WP13): commands, projects, sessions, and files in one box.
// Mod+P opens file-focused mode; `is:archived` reveals archived sessions.
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { commandHint, filterPalette, listCommands } from "../commands.ts";
import { api, type FileSearchHitDto, type WorkspaceSearchItemDto } from "@polyth/session/web-api";
import { activateProject, openEditorFile, setOverlay, setUiError, useStore } from "../store.ts";
import { openSession, refreshSessions } from "../init.ts";
import { announce } from "./a11y/live.tsx";
import { tr } from "../i18n/index.ts";
import { useShellMode } from "../responsiveShell.ts";
import { commandIcon, Button, Icon, ResponsiveOverlay, TextInput } from "./ui/index.ts";
import { orderEntries, type PaletteEntry } from "../paletteOrdering.ts";
import { promptAlert } from "../alerts.ts";
import {
  archiveSessionWithPolicy,
  renameSessionTitle,
  toggleSessionPin,
  type SessionActionTarget,
} from "../sessionActions.ts";
import { friendlyError } from "../settings.ts";

type SessionPaletteVerb = "archive" | "pin" | "rename";
const SESSION_PALETTE_VERBS: readonly SessionPaletteVerb[] = [
  "archive",
  "pin",
  "rename",
];

function CommandIcon({ name }: { name: string | undefined }) {
  const glyph = commandIcon(name);
  return glyph ? <Icon icon={glyph} size="sm" /> : null;
}

/** Pull an `is:archived` token out of the raw query. */
export function parseQuery(raw: string): { text: string; archived: boolean } {
  const archived = /(^|\s)is:archived(\s|$)/i.test(raw);
  return { text: raw.replace(/(^|\s)is:archived(?=\s|$)/gi, " ").trim(), archived };
}

export default function CommandPalette() {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const [sessionActionIndex, setSessionActionIndex] = useState<number | null>(null);
  const [files, setFiles] = useState<FileSearchHitDto[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSearchItemDto[]>([]);
  const seq = useRef(0);
  const shellMode = useShellMode();
  const phone = shellMode === "phone";
  const projectId = useStore((s) => s.activeProjectId);
  // File search resolves against the active session's worktree (P0).
  const sessionId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const mode = useStore((s) => s.paletteMode);
  const filesMode = mode === "files";
  const { text, archived } = useMemo(() => parseQuery(q), [q]);

  const cmds = useMemo(
    () => (filesMode ? [] : filterPalette(listCommands(), text)),
    [filesMode, text],
  );
  useEffect(() => {
    setI(0);
    setSessionActionIndex(null);
  }, [q]);

  // Debounced remote searches; stale responses are dropped by sequence.
  useEffect(() => {
    const mySeq = ++seq.current;
    const wantFiles = !!projectId && text.length >= (filesMode ? 1 : 2);
    // `is:archived` alone lists recent archived sessions (server-bounded).
    const wantWorkspaces = !filesMode && (archived || text.length >= 2);
    if (!wantFiles) setFiles([]);
    if (!wantWorkspaces) setWorkspaces([]);
    if (!wantFiles && !wantWorkspaces) return;
    const h = setTimeout(() => {
      if (wantFiles) {
        void api.filesSearchScored(projectId!, text, filesMode ? 20 : 8, false, sessionId ?? undefined).then((hits) => {
          if (mySeq === seq.current) setFiles(hits);
        });
      }
      if (wantWorkspaces) {
        void api.searchWorkspaces(text, 10, archived).then((items) => {
          if (mySeq === seq.current) setWorkspaces(items);
        });
      }
    }, 150);
    return () => clearTimeout(h);
  }, [text, archived, filesMode, projectId, sessionId]);

  const entries = useMemo<PaletteEntry[]>(
    () => orderEntries([
      ...cmds.map((c): PaletteEntry => ({ kind: "cmd", id: c.id, cmd: c })),
      ...workspaces.map((w): PaletteEntry => ({
        kind: "workspace",
        id: `${w.kind}:${w.id}`,
        item: w,
      })),
      ...(phone && !filesMode
        ? [{ kind: "session-search" as const, id: "session-search" as const }]
        : []),
      ...files.map((f): PaletteEntry => ({ kind: "file", id: `file:${f.path}`, hit: f })),
    ], shellMode),
    [cmds, workspaces, files, filesMode, phone, shellMode],
  );
  useEffect(() => {
    setI((current) => Math.min(current, Math.max(entries.length - 1, 0)));
    setSessionActionIndex(null);
  }, [entries.length]);

  const run = (entry: PaletteEntry) => {
    if (entry.kind === "session-search") {
      setOverlay("search");
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
          announce(tr("commandpalette.thatSessionNoLongerExists"));
          setUiError(tr("commandpalette.thatSessionNoLongerExists"));
        });
      }
    } else {
      openEditorFile(entry.hit.path);
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
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // IME safety
    const selected = entries[i];
    const selectedSession = selected?.kind === "workspace"
      && selected.item.kind === "session"
      ? selected
      : null;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSessionActionIndex(null);
      setI((n) => (n + 1) % Math.max(entries.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSessionActionIndex(null);
      setI((n) => (n - 1 + entries.length) % Math.max(entries.length, 1));
    } else if ((e.key === "Tab" || e.key === "ArrowRight") && selectedSession) {
      e.preventDefault();
      setSessionActionIndex((current) => {
        const direction = e.key === "Tab" && e.shiftKey ? -1 : 1;
        return current === null
          ? (direction > 0 ? 0 : SESSION_PALETTE_VERBS.length - 1)
          : (current + direction + SESSION_PALETTE_VERBS.length)
            % SESSION_PALETTE_VERBS.length;
      });
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      if (selectedSession && sessionActionIndex !== null) {
        void runSessionVerb(
          selectedSession,
          SESSION_PALETTE_VERBS[sessionActionIndex]!,
        );
      } else {
        run(selected);
      }
    }
  };

  const groupOf = (entry: PaletteEntry): string => {
    if (entry.kind === "cmd") return entry.cmd.group ?? "";
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
      <kbd>{tr("commandpalette.esc")}</kbd> {tr("commandpalette.close")}
    </div>
  );
  const contentOf = (entry: PaletteEntry) => (
    <>
      {entry.kind === "cmd" && (
        <>
          <CommandIcon name={entry.cmd.icon} />
          {entry.cmd.checked && (
            <span className="palette-check" aria-hidden="true">{entry.cmd.checked() ? "✓" : tr("commandpalette.u00a0")}</span>
          )}
          <span className="palette-label">
            {entry.cmd.label}
            {entry.cmd.checked?.() && <span className="sr-only"> {tr("commandpalette.current")}</span>}
          </span>
          {commandHint(entry.cmd) && <kbd>{commandHint(entry.cmd)}</kbd>}
        </>
      )}
      {entry.kind === "workspace" && (
        <>
          <span className="palette-col">
            <span className="palette-label">
              {entry.item.title}
              {entry.item.archived && <span className="palette-status archived"> {tr("commandpalette.archived")}</span>}
            </span>
            {entry.item.subtitle && <span className="palette-sub">{entry.item.subtitle}</span>}
          </span>
          <span className="palette-meta">
            {entry.item.kind === "project" ? tr("commandpalette.switchProject") : tr("commandpalette.openSession")}
          </span>
        </>
      )}
      {entry.kind === "session-search" && (
        <>
          <CommandIcon name="search" />
          <span className="palette-label">Search inside conversations…</span>
          <span className="palette-meta">{tr("shell.searchSessions")}</span>
        </>
      )}
      {entry.kind === "file" && (
        <>
          <span className="palette-col">
            <span className="palette-label mono">{baseOf(entry.hit.path)}</span>
            {dirOf(entry.hit.path) && <span className="palette-sub mono">{dirOf(entry.hit.path)}</span>}
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
      dialogSize="md"
      className="palette"
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
      sheetFooter={footer}
      dialogFooter={footer}
    >
      {!phone && (
        <div className="palette-heading">
        <span className="palette-heading-description">
          {tr("commandpalette.commandsProjectsSessionsAndFiles")}
        </span>
        </div>
      )}
      {!phone && (
        <TextInput
          className="palette-input"
          value={q}
          role="combobox"
          aria-expanded={entries.length > 0}
          aria-controls="palette-listbox"
          aria-activedescendant={entries[i] ? `palette-opt-${i}` : undefined}
          aria-autocomplete="list"
          placeholder={placeholder}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
      )}
      <div className="palette-list" role="listbox" id="palette-listbox" aria-label={tr("commandpalette.paletteResults")}>
        {entries.length === 0 && <div className="palette-empty">{tr("commandpalette.noMatches")}</div>}
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
                ref={n === i ? (element) => element?.scrollIntoView({ block: "nearest" }) : null}
                onMouseEnter={() => {
                  setI(n);
                  setSessionActionIndex(null);
                }}
              >
                <button className="palette-session-main" onClick={() => run(entry)}>
                  {contentOf(entry)}
                </button>
                <span className="palette-session-actions" aria-label={tr("mobile.sessionmenu.sessionActions")}>
                  {SESSION_PALETTE_VERBS.map((verb, actionIndex) => {
                    const target = sessionTarget(entry);
                    const label = verb === "archive"
                      ? tr("common.archive")
                      : verb === "pin"
                        ? target.pinned
                          ? tr("sidebar.sessionlist.unpin")
                          : tr("sidebar.sessionlist.pinToTop")
                        : tr("common.rename");
                    return (
                      <Button
                        key={verb}
                        type="button"
                        size="sm"
                        variant="ghost"
                        className={`palette-session-action${n === i && sessionActionIndex === actionIndex ? " active" : ""}`}
                        aria-label={`${label}: ${entry.item.title}`}
                        tabIndex={-1}
                        onClick={() => void runSessionVerb(entry, verb)}
                      >
                        {label}
                      </Button>
                    );
                  })}
                </span>
              </div>
            ) : (
              <button
                className={`palette-item ${n === i ? "active" : ""} ${entry.kind === "workspace" ? `palette-${entry.item.kind}` : ""}`}
                role="option"
                id={`palette-opt-${n}`}
                aria-selected={n === i}
                ref={n === i ? (element) => element?.scrollIntoView({ block: "nearest" }) : null}
                onClick={() => run(entry)}
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
