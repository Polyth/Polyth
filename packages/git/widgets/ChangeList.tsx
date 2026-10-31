// The working-tree change list: conflict / staged / changes / untracked groups,
// each rendered flat (filename + directory) or as a folder tree. Rendering
// only — every mutation is a callback owned by GitView.
import type { CSSProperties, DragEvent } from "react";
import type { GitFileEntry } from "@polyth/session/web-api";
import type { ResourceRef, WebResourceLinkProps, WebUiComponent } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  Icon as UiIcon,
  IconButton,
  Menu,
  MinusIcon,
  MoreIcon,
  StageIcon,
  UndoIcon,
  type MenuEntry,
} from "../../../apps/web/src/components/ui/index.ts";
import type { DiffLineStats } from "./PendingChangesBar.tsx";
import type { GitPrefs } from "./gitPrefs.ts";
import { CountBadge, LineStats, fileIdentity, fileStatusChip } from "./sourceControlParts.tsx";

export interface ChangeGroup {
  id: string;
  title: string;
  files: GitFileEntry[];
}

export function fileStatKey(file: GitFileEntry): string {
  return `${file.staged ? "s" : "u"}:${file.path}`;
}

interface RowHandlers {
  selected: { path: string; staged: boolean } | null;
  busy: boolean;
  fileStats: Record<string, DiffLineStats>;
  lineStats: GitPrefs["lineStats"];
  ResourceLink?: WebUiComponent<WebResourceLinkProps>;
  resourceFor?: (file: GitFileEntry) => ResourceRef | undefined;
  onOpen: (file: GitFileEntry) => void;
  onDragFile?: (event: DragEvent<HTMLElement>, file: GitFileEntry) => void;
  onStage: (file: GitFileEntry) => void;
  onDiscard: (file: GitFileEntry) => void;
}

export function GitFileRow({ file, selected, busy, stats, lineStats = "numbers", depth, resource, ResourceLink, onOpen, onDragStart, onStage, onDiscard }: {
  file: GitFileEntry;
  selected: boolean;
  busy: boolean;
  stats?: DiffLineStats;
  lineStats?: GitPrefs["lineStats"];
  /** Tree depth; set only in tree mode, where the folder rows carry the path. */
  depth?: number;
  resource?: ResourceRef;
  ResourceLink?: WebUiComponent<WebResourceLinkProps>;
  onOpen: () => void;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onStage: () => void;
  onDiscard?: () => void;
}) {
  const identity = fileIdentity(file.path);
  const title = file.origPath ? `${file.origPath} → ${file.path}` : file.path;
  const directory = depth === undefined
    ? (file.origPath ? `${file.origPath} → ${identity.directory}` : identity.directory)
    : (file.origPath ? `← ${fileIdentity(file.origPath).name}` : "");
  const discardLabel = tr("gitview.revertValue", { path: file.path });
  const overflowEntries: MenuEntry[] = onDiscard && file.staged
    ? [{
        id: "discard",
        label: discardLabel,
        icon: UndoIcon,
        danger: true,
        disabled: busy,
        onSelect: onDiscard,
      }]
    : [];
  const style = depth === undefined ? undefined : { "--sc-depth": depth } as CSSProperties;
  const statusChip = fileStatusChip(file);
  return (
    <div className={`git-file-row ${selected ? "selected" : ""}`} data-tree={depth === undefined ? undefined : "true"} style={style}>
      {ResourceLink && resource ? (
        <div className="git-file-main" role="button" tabIndex={0} draggable={Boolean(onDragStart)} onDragStart={onDragStart} aria-current={selected ? "true" : undefined} onClick={onOpen} onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); }
        }} title={title}>
          {statusChip}
          <span className="git-file-identity">
            <ResourceLink resource={resource} mode="compact">{identity.name}</ResourceLink>
            {directory && <span className="git-file-directory">{directory}</span>}
          </span>
        </div>
      ) : (
        <button type="button" className="git-file-main" draggable={Boolean(onDragStart)} onDragStart={onDragStart} aria-current={selected ? "true" : undefined} onClick={onOpen} title={title}>
          {statusChip}
          <span className="git-file-identity">
            <span className="git-file-name">{identity.name}</span>
            {directory && <span className="git-file-directory">{directory}</span>}
          </span>
        </button>
      )}
      {stats && <LineStats stats={stats} mode={lineStats} />}
      <span className="git-file-actions">
        {onDiscard && !file.staged && (
          <IconButton
            icon={UndoIcon}
            size="sm"
            variant="ghost"
            className="git-file-discard"
            title={tr("gitview.revert")}
            label={discardLabel}
            disabled={busy}
            onClick={onDiscard}
          />
        )}
        {overflowEntries.length > 0 && (
          <Menu label={tr("common.more")} align="end" entries={overflowEntries}>
            {(trigger) => <IconButton {...trigger} icon={MoreIcon} size="sm" variant="ghost" label={tr("common.more")} disabled={busy} />}
          </Menu>
        )}
        <IconButton
          icon={file.staged ? MinusIcon : StageIcon}
          size="sm"
          variant="ghost"
          className="git-file-stage"
          label={file.staged ? tr("gitview.unstageValue", { path: file.path }) : tr("gitview.stageValue", { path: file.path })}
          title={file.staged ? tr("gitview.unstage") : tr("gitview.stage")}
          disabled={busy}
          onClick={onStage}
        />
      </span>
    </div>
  );
}

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: GitFileEntry[];
  total: number;
}

/** Folder tree with single-child chains folded ("packages/git/widgets"), so a
 *  deep change does not cost one click per directory level. */
export function buildChangeTree(files: readonly GitFileEntry[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [], total: 0 };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    node.total += 1;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.dirs.get(part);
      if (!next) { next = { name: part, path, dirs: new Map(), files: [], total: 0 }; node.dirs.set(part, next); }
      next.total += 1;
      node = next;
    }
    node.files.push(file);
  }
  const fold = (node: DirNode): DirNode => {
    let current = node;
    while (current !== root && current.files.length === 0 && current.dirs.size === 1) {
      const only = [...current.dirs.values()][0]!;
      current = { ...only, name: `${current.name}/${only.name}` };
    }
    const dirs = new Map<string, DirNode>();
    for (const child of [...current.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const folded = fold(child);
      dirs.set(folded.path, folded);
    }
    return { ...current, dirs, files: [...current.files].sort((a, b) => fileIdentity(a.path).name.localeCompare(fileIdentity(b.path).name)) };
  };
  return fold(root);
}

function collectPaths(node: DirNode): string[] {
  return [...node.files.map((file) => file.path), ...[...node.dirs.values()].flatMap(collectPaths)];
}

function TreeLevel({ node, depth, groupId, staged, closed, onToggle, onStageMany, rows }: {
  node: DirNode;
  depth: number;
  groupId: string;
  staged: boolean;
  closed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onStageMany?: (paths: string[], staged: boolean) => void;
  rows: RowHandlers & { groupId: string };
}) {
  return (
    <>
      {[...node.dirs.values()].map((dir) => {
        const key = `${groupId}:dir:${dir.path}`;
        const isClosed = closed.has(key);
        const folderLabel = staged ? tr("gitview.unstageValueFolder", { value: dir.name }) : tr("gitview.stageValueFolder", { value: dir.name });
        return (
          <div className="git-tree-branch" key={key}>
            <div className="git-tree-dir" style={{ "--sc-depth": depth } as CSSProperties}>
              <button type="button" className="git-tree-dir-head" aria-expanded={!isClosed} title={dir.path} onClick={() => onToggle(key)}>
                <span className={`git-folder-chevron${isClosed ? "" : " expanded"}`} aria-hidden="true"><UiIcon icon={ChevronRightIcon} size="sm" /></span>
                <UiIcon icon={isClosed ? FolderIcon : FolderOpenIcon} size="sm" className="git-tree-dir-icon" />
                <span className="git-tree-dir-name">{dir.name}</span>
                <CountBadge count={dir.total} />
              </button>
              {onStageMany && (
                <span className="git-tree-dir-actions">
                  <IconButton
                    icon={staged ? MinusIcon : StageIcon}
                    size="sm"
                    variant="ghost"
                    label={folderLabel}
                    title={staged ? tr("gitview.unstageFolder") : tr("gitview.stageFolder")}
                    disabled={rows.busy}
                    onClick={() => onStageMany(collectPaths(dir), !staged)}
                  />
                </span>
              )}
            </div>
            {!isClosed && <TreeLevel node={dir} depth={depth + 1} groupId={groupId} staged={staged} closed={closed} onToggle={onToggle} onStageMany={onStageMany} rows={rows} />}
          </div>
        );
      })}
      {node.files.map((file) => <ChangeRow key={`${groupId}:${file.path}`} file={file} depth={depth} {...rows} />)}
    </>
  );
}

function ChangeRow({ file, depth, groupId: _groupId, selected, busy, fileStats, lineStats, ResourceLink, resourceFor, onOpen, onDragFile, onStage, onDiscard }: RowHandlers & { file: GitFileEntry; depth?: number; groupId: string }) {
  return (
    <GitFileRow
      file={file}
      selected={selected?.path === file.path && selected.staged === file.staged}
      busy={busy}
      stats={fileStats[fileStatKey(file)]}
      lineStats={lineStats}
      {...(depth === undefined ? {} : { depth })}
      {...(ResourceLink && resourceFor ? { ResourceLink, resource: resourceFor(file) } : {})}
      onOpen={() => onOpen(file)}
      {...(onDragFile ? { onDragStart: (event: DragEvent<HTMLElement>) => onDragFile(event, file) } : {})}
      onStage={() => onStage(file)}
      {...(file.status !== "conflicted" ? { onDiscard: () => onDiscard(file) } : {})}
    />
  );
}

export function ChangeSection({ group, view, closed, onToggle, onStageMany, ...rows }: RowHandlers & {
  group: ChangeGroup;
  view: GitPrefs["changesView"];
  closed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Stage (`true`) or unstage (`false`) an explicit path set. */
  onStageMany?: (paths: string[], stage: boolean) => void;
}) {
  const isClosed = closed.has(group.id);
  const staged = group.id === "staged";
  const paths = group.files.map((file) => file.path);
  const groupAction = staged ? tr("gitview.unstageAll") : group.id === "merge" ? tr("gitview.markAllResolved") : tr("gitview.stageAll");
  return (
    <section className="git-change-group" data-group={group.id}>
      <div className="git-change-group-bar">
        <button className="git-change-group-head" type="button" aria-expanded={!isClosed} onClick={() => onToggle(group.id)}>
          <span className={`git-folder-chevron${isClosed ? "" : " expanded"}`} aria-hidden="true"><UiIcon icon={ChevronRightIcon} size="sm" /></span>
          <span className="git-change-group-title">{group.title}</span>
          <span className="git-count"><CountBadge count={group.files.length} tone={group.id === "merge" ? "danger" : "neutral"} /></span>
        </button>
        {onStageMany && (
          <span className="git-change-group-actions">
            <IconButton
              icon={staged ? MinusIcon : StageIcon}
              size="sm"
              variant="ghost"
              label={`${groupAction} · ${group.title}`}
              title={groupAction}
              disabled={rows.busy}
              onClick={() => onStageMany(paths, !staged)}
            />
          </span>
        )}
      </div>
      {!isClosed && (
        <div className="git-change-group-body">
          {view === "tree"
            ? <TreeLevel node={buildChangeTree(group.files)} depth={0} groupId={group.id} staged={staged} closed={closed} onToggle={onToggle} {...(onStageMany ? { onStageMany } : {})} rows={{ ...rows, groupId: group.id }} />
            : group.files.map((file) => <ChangeRow key={`${group.id}:${file.path}`} file={file} groupId={group.id} {...rows} />)}
        </div>
      )}
    </section>
  );
}
