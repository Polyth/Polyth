// Flat list view of the Files surface: every file of the repository in one
// list (name first, folder underneath), ordered by the tree's sort key. One
// bounded /api/files/list request instead of a folder-by-folder walk.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { FileEntry } from "@polyth/session/web-api";
import type { WorkspaceRepository } from "@polyth/contracts/workspace";
import { setDragResource } from "../../../../apps/web/src/dnd.ts";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import { Button, EmptyState, Spinner } from "../../../../apps/web/src/components/ui/index.ts";
import { FileTypeGlyph, fileTypeKeyOf } from "./fileTreeIcons.tsx";
import { splitPath } from "./searchMatch.ts";
import { entryMeta, sortFlat, type TreeSortMode } from "./treeSort.ts";
import { listFiles } from "./uploads.ts";
import type { SessionChange } from "./sessionChanges.ts";

/** Rows rendered per step; the rest arrive with "Show more". */
export const FLAT_PAGE = 400;
const LIST_REFRESH_MS = 15_000;
const CHANGE_LETTER = { created: "A", modified: "M", deleted: "D" } as const;
const CHANGE_LABEL_KEY = { created: "filetree.created", modified: "filetree.modified", deleted: "filetree.deleted" } as const;

export interface FlatFileListProps {
  projectId: string;
  sessionId: string | null;
  repository: WorkspaceRepository;
  visible: boolean;
  activePath: string | null;
  showHidden: boolean;
  hideIgnored: boolean;
  changedOnly: boolean;
  sort: TreeSortMode;
  refreshToken: number;
  changes?: ReadonlyMap<string, SessionChange>;
  onOpenFile: (path: string, repositoryId: string) => void;
  onPinFile: (path: string, repositoryId: string) => void;
  onContextMenu: (event: MouseEvent, entry: FileEntry | null, repositoryId: string) => void;
}

export default function FlatFileList({
  projectId,
  sessionId,
  repository,
  visible,
  activePath,
  showHidden,
  hideIgnored,
  changedOnly,
  sort,
  refreshToken,
  changes,
  onOpenFile,
  onPinFile,
  onContextMenu,
}: FlatFileListProps) {
  const [listing, setListing] = useState<{ scope: string; entries: FileEntry[]; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const [shown, setShown] = useState(FLAT_PAGE);
  const scope = `${projectId}\0${sessionId ?? ""}\0${repository.repositoryId}\0${showHidden}`;
  const request = useRef(0);

  useEffect(() => {
    if (!visible || repository.state !== "ready") return;
    let cancelled = false;
    const load = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const id = ++request.current;
      void listFiles({ projectId, sessionId, repositoryId: repository.repositoryId, dir: "", hidden: showHidden })
        .then((result) => {
          if (cancelled || id !== request.current) return;
          setListing({ scope, ...result });
          setError("");
        })
        .catch((cause: unknown) => {
          if (cancelled || id !== request.current) return;
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    load();
    const timer = setInterval(load, LIST_REFRESH_MS);
    window.addEventListener("polyth:files-changed", load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("polyth:files-changed", load);
    };
  }, [visible, scope, refreshToken]);
  useEffect(() => { setShown(FLAT_PAGE); }, [scope, sort, changedOnly, hideIgnored]);

  const rows = useMemo(() => {
    if (!listing || listing.scope !== scope) return null;
    const kept = listing.entries.filter((entry) =>
      (!hideIgnored || !entry.ignored) && (!changedOnly || changes?.has(entry.path)));
    return sortFlat(kept, sort);
  }, [listing, scope, hideIgnored, changedOnly, changes, sort]);
  const now = Date.now();

  if (error && !rows) return <div className="form-error">{error}</div>;
  if (!rows) return <div className="files-flat-loading"><Spinner size="sm" /></div>;
  if (rows.length === 0) {
    return <EmptyState variant="compact" title={changedOnly ? tr("filetree.noChanges") : tr("filetree.listEmpty")} />;
  }
  return (
    <div
      className="files-flat-list"
      role="list"
      aria-label={tr("filetree.view.list")}
      data-drop-dir=""
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest(".files-flat-row")) return;
        event.preventDefault();
        onContextMenu(event, null, repository.repositoryId);
      }}
    >
      {rows.slice(0, shown).map((entry) => {
        const { name, dir } = splitPath(entry.path);
        const change = changes?.get(entry.path);
        const meta = entryMeta(entry, sort, now);
        return (
          <div key={entry.path} role="listitem" className="files-flat-item" data-drop-dir={dir}>
            <button
              type="button"
              className={`files-row-main files-flat-row${activePath === entry.path ? " active" : ""}${entry.ignored ? " ft-ignored" : ""}`}
              draggable
              title={entry.path}
              onDragStart={(event) => setDragResource(event.dataTransfer, { scheme: "file", projectId, sessionId, repositoryId: repository.repositoryId, locator: entry.path })}
              onClick={() => onOpenFile(entry.path, repository.repositoryId)}
              onDoubleClick={(event) => { event.preventDefault(); onPinFile(entry.path, repository.repositoryId); }}
              onContextMenu={(event) => onContextMenu(event, { ...entry, name }, repository.repositoryId)}
            >
              <span className="files-file-icon ft-icon" data-ft={fileTypeKeyOf(name)} aria-hidden>
                <FileTypeGlyph type={fileTypeKeyOf(name)} />
              </span>
              <span className="files-hit-text">
                <span className="files-hit-name" dir="auto">{name}</span>
                {dir && <span className="files-hit-dir" dir="auto">{dir}</span>}
              </span>
              {meta && <span className="ft-meta">{meta}</span>}
              {change && (
                <span className="ft-change-badge" data-kind={change.kind} data-recent={change.latestTurn || undefined} title={tr(CHANGE_LABEL_KEY[change.kind])}>
                  {CHANGE_LETTER[change.kind]}
                </span>
              )}
            </button>
          </div>
        );
      })}
      {(rows.length > shown || listing?.truncated) && (
        <div className="files-flat-more">
          {rows.length > shown ? (
            <Button size="sm" variant="ghost" onClick={() => setShown((value) => value + FLAT_PAGE)}>
              {tr("filetree.showMore", { count: Math.min(FLAT_PAGE, rows.length - shown) })}
            </Button>
          ) : (
            <span>{tr("filetree.listTruncated", { count: rows.length })}</span>
          )}
        </div>
      )}
    </div>
  );
}
