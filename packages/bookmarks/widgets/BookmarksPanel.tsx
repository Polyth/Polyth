// The whole list: a page on a phone, a pane beside Chat on a computer. A row's
// name goes to its place in the chat and its arrow opens the saved text, the
// same split as the prompt navigator's rows.
import { useEffect, useId, useMemo, useState } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import {
  BookmarkIcon,
  Button,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  DeleteIcon,
  EditIcon,
  EmptyState,
  Icon,
  IconButton,
  MarkdownIcon,
  Menu,
  MoreIcon,
  PlusIcon,
  QuoteIcon,
  Select,
  SortIcon,
  Spinner,
  Tabs,
  type LucideIcon,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import { dateTimeFormatter, getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import { getState, setPaneFullscreen } from "../../../apps/web/src/store.ts";
import { copyText } from "../../../apps/web/src/utils.ts";
import type { BookmarkKind, BookmarkView } from "../src/bookmarks.ts";
import {
  exportBookmarks,
  placesOf,
  readBookmarkBody,
  refreshBookmarks,
  setBookmarkWalk,
  useBookmarkWalk,
  useProjectBookmarks,
} from "./client.ts";
import { BOOKMARKS_SURFACE_ID } from "./ids.ts";
import { deliverMarkdownFile, removeWithUndo, reportFailure, reportMissingPlace, revealBookmark } from "./commands.ts";
import { BookmarkEditor, NoteComposer } from "./BookmarkEditor.tsx";
import { LinkRow, SavedText } from "./SavedText.tsx";

type Tab = "bookmarks" | "links";
type Scope = "chat" | "project";

const KIND_ICONS: Record<BookmarkKind, LucideIcon> = {
  answer: BookmarkIcon,
  section: BookmarkIcon,
  fragment: QuoteIcon,
  note: MarkdownIcon,
};

function linkCount(count: number): string {
  return tr(new Intl.PluralRules(getLocale()).select(count) === "one" ? "bookmarks.row.linksOne" : "bookmarks.row.linksMany", { count });
}

function metaOf(bookmark: BookmarkView): string {
  const when = dateTimeFormatter(getLocale(), { dateStyle: "short", timeStyle: "short" }).format(new Date(bookmark.createdAt));
  const bits: string[] = [];
  if (bookmark.kind === "fragment") bits.push(tr("bookmarks.kind.fragment"));
  if (bookmark.kind === "note") bits.push(tr("bookmarks.kind.note"));
  bits.push(when);
  if (bookmark.links.length > 0) bits.push(linkCount(bookmark.links.length));
  if (bookmark.edited) bits.push(tr("bookmarks.row.edited"));
  return bits.join(" · ");
}

function BookmarkRow({ host, bookmark, open, active, onToggle, onJump, onCopy, onRemove }: {
  host: WebPackageHost;
  bookmark: BookmarkView;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  onJump: () => void;
  onCopy: () => void;
  onRemove: () => void;
}) {
  const panelId = useId();
  const [editing, setEditing] = useState(false);
  const reachable = bookmark.chat === "open" && bookmark.eventSeq !== undefined;
  return (
    <li className="bm-item" data-open={open || undefined} data-active={active || undefined} data-bookmark={bookmark.id}>
      <div className="bm-row">
        <button
          type="button"
          className="bm-row-main"
          // A note or a deleted chat has nowhere to go: the name opens the text.
          onClick={reachable ? onJump : onToggle}
          {...(reachable ? {} : { "aria-expanded": open, "aria-controls": panelId })}
        >
          <span className="bm-row-glyph" aria-hidden="true"><Icon icon={KIND_ICONS[bookmark.kind]} size="sm" /></span>
          <span className="bm-row-text">
            <bdi className="bm-row-title">{bookmark.title}</bdi>
            <span className="bm-row-meta">{metaOf(bookmark)}</span>
          </span>
        </button>
        <IconButton
          icon={open ? ChevronDownIcon : ChevronRightIcon}
          label={tr(open ? "bookmarks.row.collapse" : "bookmarks.row.expand", { title: bookmark.title })}
          size="sm"
          variant="ghost"
          className="bm-row-expand"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        />
      </div>
      <div id={panelId} className="bm-row-panel" hidden={!open}>
        {open && (editing ? <BookmarkEditor host={host} bookmark={bookmark} onDone={() => setEditing(false)} /> : (
          <>
            {bookmark.note && <blockquote className="bm-note" dir="auto">{bookmark.note}</blockquote>}
            <SavedText bookmark={bookmark} />
            <div className="bm-row-actions">
              <Button size="sm" variant="ghost" iconStart={EditIcon} onClick={() => setEditing(true)}>{tr("bookmarks.row.edit")}</Button>
              <Button size="sm" variant="ghost" iconStart={CopyIcon} onClick={onCopy}>{tr("bookmarks.row.copy")}</Button>
              <Button size="sm" variant="ghost" iconStart={DeleteIcon} onClick={onRemove}>{tr("bookmarks.row.remove")}</Button>
            </div>
          </>
        ))}
      </div>
    </li>
  );
}

/** Rows under a heading per chat when the list covers more than one. */
function groupByChat(bookmarks: readonly BookmarkView[]): Array<{ key: string; title: string | null; deleted: boolean; rows: BookmarkView[] }> {
  const groups = new Map<string, { key: string; title: string | null; deleted: boolean; rows: BookmarkView[] }>();
  for (const bookmark of bookmarks) {
    const key = bookmark.sessionId ?? "";
    const group = groups.get(key);
    if (group) group.rows.push(bookmark);
    else groups.set(key, { key, title: bookmark.chatTitle ?? null, deleted: bookmark.chat === "deleted", rows: [bookmark] });
  }
  return [...groups.values()];
}

export default function BookmarksPanel({ host, projectId, sessionId, active }: {
  host: WebPackageHost;
  projectId?: string | null;
  sessionId?: string | null;
  active?: boolean;
}) {
  const shellMode = useShellMode();
  const project = useProjectBookmarks(projectId);
  const walk = useBookmarkWalk();
  const [tab, setTab] = useState<Tab>("bookmarks");
  const [scopeChoice, setScopeChoice] = useState<Scope>("chat");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [writing, setWriting] = useState(false);
  const scope: Scope = sessionId ? scopeChoice : "project";

  useEffect(() => { if (active !== false && projectId) void refreshBookmarks(projectId); }, [active, projectId]);

  const shown = useMemo(
    () => (scope === "chat" ? project.bookmarks.filter((bookmark) => bookmark.sessionId === sessionId) : project.bookmarks),
    [project.bookmarks, scope, sessionId],
  );
  const places = placesOf(shown);
  const linkGroups = shown.filter((bookmark) => bookmark.links.length > 0);
  const linksTotal = linkGroups.reduce((sum, bookmark) => sum + bookmark.links.length, 0);

  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  /** Where this pane covers Chat, Chat is inert and focus cannot land in it, so
   *  the pane yields first and comes back if the place cannot be shown. */
  const jump = async (bookmark: BookmarkView) => {
    const phone = shellMode === "phone";
    const yieldLayer = phone || getState().paneFullscreen;
    if (yieldLayer) {
      if (phone) host.navigation.closeWorkspacePane();
      else setPaneFullscreen(false);
    }
    if (bookmark.sessionId) setBookmarkWalk({ sessionId: bookmark.sessionId, activeId: bookmark.id });
    if (await revealBookmark(host, bookmark, true)) return;
    setBookmarkWalk(null);
    if (yieldLayer) {
      if (phone) host.navigation.openWorkspacePane(BOOKMARKS_SURFACE_ID);
      else setPaneFullscreen(true);
    }
    reportMissingPlace(host);
  };

  const copy = async (bookmark: BookmarkView) => {
    try {
      if (!await copyText(await readBookmarkBody(bookmark))) throw new Error("copy");
      host.notifications?.show({ id: "bookmarks.copied", kind: "success", title: tr("bookmarks.copied") });
    } catch (cause) {
      reportFailure(host, tr("bookmarks.failed.copy"), cause);
    }
  };

  const exportScope = () => ({
    projectId: projectId!,
    ...(scope === "chat" && sessionId ? { sessionId } : {}),
  });

  const exportFile = async () => {
    try {
      const { fileName, markdown } = await exportBookmarks(exportScope());
      const outcome = await deliverMarkdownFile(fileName, markdown);
      if (outcome !== "cancelled") {
        host.notifications?.show({ id: "bookmarks.exported", kind: "success", title: tr("bookmarks.exported", { name: fileName }) });
      }
    } catch (cause) {
      reportFailure(host, tr("bookmarks.failed.export"), cause);
    }
  };

  const copyAll = async () => {
    try {
      const { markdown } = await exportBookmarks(exportScope());
      if (!await copyText(markdown)) throw new Error("copy");
      host.notifications?.show({ id: "bookmarks.copied", kind: "success", title: tr("bookmarks.copied") });
    } catch (cause) {
      reportFailure(host, tr("bookmarks.failed.copy"), cause);
    }
  };

  const menu: MenuEntry[] = [
    { id: "expand", label: tr("bookmarks.menu.expandAll"), disabled: shown.length === 0, onSelect: () => { setTab("bookmarks"); setOpen(new Set(shown.map((bookmark) => bookmark.id))); } },
    { id: "collapse", label: tr("bookmarks.menu.collapseAll"), disabled: open.size === 0, onSelect: () => setOpen(new Set()) },
    "separator",
    { id: "export", label: tr("bookmarks.menu.export"), icon: MarkdownIcon, disabled: shown.length === 0, onSelect: () => void exportFile() },
    { id: "copy", label: tr("bookmarks.menu.copyAll"), icon: CopyIcon, disabled: shown.length === 0, onSelect: () => void copyAll() },
  ];

  const startWalk = () => {
    const first = places[0];
    if (first) void jump(first);
  };

  const count = (value: number) => <span className="bm-count">{value}</span>;

  return (
    <div className="bm-panel">
      <div className="bm-toolbar">
        <Tabs
          size="sm"
          className="bm-tabs"
          label={tr("bookmarks.tabs.label")}
          value={tab}
          onChange={(value) => setTab(value as Tab)}
          tabs={[
            { id: "bookmarks", label: <>{tr("bookmarks.tab.bookmarks")}{count(shown.length)}</> },
            { id: "links", label: <>{tr("bookmarks.tab.links")}{count(linksTotal)}</> },
          ]}
        />
        <div className="bm-toolbar-end">
          {sessionId && (
            <Select
              label={tr("bookmarks.scope.label")}
              ariaLabel={tr("bookmarks.scope.label")}
              className="bm-scope"
              value={scope}
              searchable={false}
              align="end"
              onChange={(value) => setScopeChoice(value as Scope)}
              options={[
                { value: "chat", label: tr("bookmarks.scope.chat") },
                { value: "project", label: tr("bookmarks.scope.project") },
              ]}
            />
          )}
          <Menu label={tr("bookmarks.menu.label")} entries={menu} align="end">
            {(trigger) => <IconButton {...trigger} icon={MoreIcon} label={tr("bookmarks.menu.label")} size="sm" variant="ghost" />}
          </Menu>
        </div>
      </div>

      {tab === "bookmarks" && projectId && (
        <div className="bm-actions">
          <Button size="sm" variant="ghost" iconStart={PlusIcon} aria-expanded={writing} onClick={() => setWriting((value) => !value)}>{tr("bookmarks.kind.note")}</Button>
          {places.length > 0 && scope === "chat" && (
            <Button size="sm" variant="ghost" iconStart={SortIcon} onClick={startWalk}>{tr("bookmarks.walk.start")}</Button>
          )}
        </div>
      )}

      {tab === "bookmarks" && writing && projectId && (
        <NoteComposer
          host={host}
          place={scope === "chat" && sessionId ? { sessionId } : { projectId }}
          onDone={() => setWriting(false)}
        />
      )}

      {project.error && !project.loaded ? (
        <p className="bm-status" role="alert">
          {tr("bookmarks.failed.load")}
          <Button size="sm" variant="ghost" onClick={() => { if (projectId) void refreshBookmarks(projectId); }}>{tr("bookmarks.retry")}</Button>
        </p>
      ) : !project.loaded ? (
        <p className="bm-status" role="status"><Spinner size="sm" />{tr("bookmarks.loading")}</p>
      ) : tab === "bookmarks" ? (
        shown.length === 0 ? (
          <EmptyState variant="panel" title={tr("bookmarks.empty.title")} description={tr("bookmarks.empty.body")} />
        ) : (
          <div className="bm-list-wrap">
            {groupByChat(shown).map((group) => (
              <section key={group.key} className="bm-group">
                {scope === "project" && (
                  <h3 className="bm-group-head">
                    <bdi>{group.key ? group.title ?? tr("bookmarks.chat.untitled") : tr("bookmarks.chat.notes")}</bdi>
                    {group.deleted && <span className="bm-group-state">{tr("bookmarks.chat.deleted")}</span>}
                  </h3>
                )}
                <ul className="bm-list">
                  {group.rows.map((bookmark) => (
                    <BookmarkRow
                      key={bookmark.id}
                      host={host}
                      bookmark={bookmark}
                      open={open.has(bookmark.id)}
                      active={walk?.activeId === bookmark.id}
                      onToggle={() => toggle(bookmark.id)}
                      onJump={() => void jump(bookmark)}
                      onCopy={() => void copy(bookmark)}
                      onRemove={() => void removeWithUndo(host, bookmark.id)}
                    />
                  ))}
                </ul>
              </section>
            ))}
            <p className="bm-privacy">{tr("bookmarks.privacy")}</p>
          </div>
        )
      ) : linkGroups.length === 0 ? (
        <EmptyState variant="panel" title={tr("bookmarks.links.empty")} />
      ) : (
        <div className="bm-list-wrap">
          {linkGroups.map((bookmark) => (
            <section key={bookmark.id} className="bm-group">
              <h3 className="bm-group-head"><bdi>{bookmark.title}</bdi></h3>
              <ul className="bm-list">
                {bookmark.links.map((link) => <LinkRow key={link.url} link={link} />)}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
