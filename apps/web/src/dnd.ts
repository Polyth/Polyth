// Drag-and-drop helpers: the polyth path mime carries tree→composer drags;
// desktop-file drops upload through the binary API and become attachment pills.
import { api } from "@polyth/session/web-api";
import { attachProjectFile, attachUpload } from "./attachments.ts";
import type { OpenResourceOptions, ResourceDragContext, ResourceDragOptions, ResourceRef } from "@polyth/web-sdk";
import { resolveWorkspaceContext, workspaceRepository } from "@polyth/contracts/workspace";
import { beginExternalRailDrag, endExternalRailDrag } from "./railDrag.ts";
import { getState } from "./store.ts";
import { hunkDigest, splitHunks } from "./review/anchors.ts";
import { tr } from "./i18n/index.ts";

export const PATH_MIME = "application/x-polyth-path";
export const RESOURCE_MIME = "application/x-polyth-resource";
export const WIDGET_MIME = "application/x-polyth-widget";
export const CAPABILITY_MIME = "application/x-polyth-capability";
/** A navigator chat row dragged onto the workspace opens it in split view. */
export const SESSION_MIME = "application/x-polyth-session";

interface DataLike {
  setData(type: string, value: string): void;
  getData(type: string): string;
}

export function setDragPath(dt: DataLike, path: string): void {
  dt.setData(PATH_MIME, path);
  dt.setData("text/plain", `@${path}`);
}

export function getDragPath(dt: DataLike): string | null {
  return dt.getData(PATH_MIME) || null;
}

export function setDragSession(dt: DataLike, sessionId: string): void {
  dt.setData(SESSION_MIME, sessionId);
}

/** Drag types are readable during dragover; the payload only on drop. */
export function hasDragSession(dt: { types: readonly string[] }): boolean {
  return Array.from(dt.types).includes(SESSION_MIME);
}

/** Drag data is untrusted: only an id-shaped value is a chat to open. */
export function getDragSession(dt: Pick<DataLike, "getData">): string | null {
  const raw = dt.getData(SESSION_MIME).trim();
  return raw && raw.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(raw) ? raw : null;
}

export type DragResource = ResourceRef & ResourceDragOptions;

export function setDragResource(dt: DataLike, resource: ResourceRef, selection?: OpenResourceOptions["selection"], context?: ResourceDragContext): void {
  dt.setData(RESOURCE_MIME, JSON.stringify({ ...resource, ...(selection ? { selection } : {}), ...(context ? { context } : {}) }));
  setDragPath(dt, resource.locator);
}

/** Drag data is untrusted. Never derive filesystem authority from its path. */
export function getDragResource(dt: Pick<DataLike, "getData">): DragResource | null {
  try {
    const raw = dt.getData(RESOURCE_MIME);
    if (!raw || raw.length > 8192) return null;
    const ref = JSON.parse(raw) as DragResource;
    if (ref.scheme !== "file" || typeof ref.projectId !== "string" || !ref.projectId
      || typeof ref.locator !== "string" || !ref.locator || ref.locator.length > 4096
      || ref.locator.startsWith("/") || /^[A-Za-z]:/.test(ref.locator)
      || ref.locator.includes("\0") || ref.locator.split(/[/\\]/).includes("..")
      || (ref.sessionId !== null && ref.sessionId !== undefined && typeof ref.sessionId !== "string")
      || (ref.repositoryId !== undefined && (typeof ref.repositoryId !== "string" || !ref.repositoryId))) return null;
    const selection = ref.selection;
    if (selection !== undefined && (!selection || typeof selection !== "object"
      || !Number.isSafeInteger(selection.startLine) || selection.startLine < 1
      || (selection.endLine !== undefined && (!Number.isSafeInteger(selection.endLine) || selection.endLine < selection.startLine))
      || (selection.column !== undefined && (!Number.isSafeInteger(selection.column) || selection.column < 1)))) return null;
    const context = ref.context;
    if (context !== undefined && (!context || typeof context !== "object"
      || (context.kind !== "directory" && context.kind !== "working-changes"))) return null;
    if (context?.kind === "working-changes" && (
      (context.staged !== undefined && typeof context.staged !== "boolean")
      || (context.snapshotDigest !== undefined && (typeof context.snapshotDigest !== "string" || !/^[a-f0-9]{8,128}$/i.test(context.snapshotDigest)))
      || (context.hunkDigest !== undefined && (typeof context.hunkDigest !== "string" || !/^[a-f0-9]{8,128}$/i.test(context.hunkDigest)))
    )) return null;
    return { scheme: "file", projectId: ref.projectId, sessionId: ref.sessionId ?? null, locator: ref.locator,
      ...(ref.repositoryId ? { repositoryId: ref.repositoryId } : {}),
      ...(context ? { context: context.kind === "directory" ? { kind: "directory" as const } : {
        kind: "working-changes" as const,
        ...(context.staged === undefined ? {} : { staged: context.staged }),
        ...(context.snapshotDigest ? { snapshotDigest: context.snapshotDigest } : {}),
        ...(context.hunkDigest ? { hunkDigest: context.hunkDigest } : {}),
      } } : {}),
      ...(selection ? { selection: { startLine: selection.startLine,
        ...(selection.endLine === undefined ? {} : { endLine: selection.endLine }),
        ...(selection.column === undefined ? {} : { column: selection.column }),
      } } : {}) };
  } catch { return null; }
}

/** Resolve a terminal insertion against registered, visible workspace roots. */
export function resourceShellPath(ref: ResourceRef): string | null {
  const validated = getDragResource({ getData: () => JSON.stringify(ref) });
  if (!validated) return null;
  ref = validated;
  const state = getState();
  const project = state.projectRegistry.projects.find((row) => row.id === ref.projectId);
  const session = ref.sessionId ? state.sessions.find((row) => row.id === ref.sessionId) : null;
  if (!project || (ref.sessionId && !session)) return null;
  try {
    const context = resolveWorkspaceContext(project, session);
    const repository = ref.repositoryId ? workspaceRepository(context, ref.repositoryId)
      : context.repositories.find((row) => row.repositoryId === project.primaryRepositoryId)
        ?? context.repositories[0];
    if (!repository || repository.state !== "ready") return null;
    const fullPath = `${repository.path.replace(/[/\\]$/, "")}/${ref.locator}`;
    return `'${fullPath.replaceAll("'", "'\\''")}'`;
  } catch { return null; }
}

export function setDragWidget(dt: DataLike, widgetId: string): void {
  dt.setData(WIDGET_MIME, widgetId);
  dt.setData("text/plain", widgetId);
}

export function getDragWidget(dt: Pick<DataLike, "getData">): string | null {
  return dt.getData(WIDGET_MIME) || null;
}

export function setDragCapability(dt: DataLike, id: string): void {
  dt.setData(CAPABILITY_MIME, id);
  dt.setData("text/plain", id);
}

export function getDragCapability(dt: Pick<DataLike, "getData">): string | null {
  return dt.getData(CAPABILITY_MIME) || null;
}

/**
 * A capability dragged in from anywhere that is not already a rail — the
 * Custom actions window, a settings list — turns the icon rails into drop
 * targets: the host watches the document for a drag carrying
 * `CAPABILITY_MIME`, lights the rails up (railDrag.ts) and lets the rail
 * under the pointer preview where the icon would land. The drag SOURCE only
 * has to call `setDragCapability`; no package reaches into rail internals.
 * Returns the disposer.
 */
export function installExternalCapabilityDrag(): () => void {
  const carries = (event: DragEvent) => (event.dataTransfer?.types as readonly string[] | undefined)?.includes(CAPABILITY_MIME) ?? false;
  // Bubble phase: the source's own `dragstart` has already set the payload by
  // then, so Chromium exposes the capability id here. Firefox hides custom
  // payloads until the drop, so an armed-but-empty drag is normal there and
  // the rail under the pointer resolves the id from `dragover` instead.
  const onStart = (event: DragEvent) => {
    if (!carries(event)) return;
    beginExternalRailDrag(getDragCapability({ getData: (type) => event.dataTransfer?.getData(type) ?? "" }) ?? "");
  };
  // `dragend` always follows a drop, wherever it landed, so one listener
  // covers both a cancelled drag and a drop outside every rail. It must NOT
  // be paired with a document-level `drop`: capture runs before the rail's
  // own handler and would clear the drag before the rail could commit it.
  const onEnd = () => endExternalRailDrag();
  document.addEventListener("dragstart", onStart);
  document.addEventListener("dragend", onEnd, true);
  return () => {
    document.removeEventListener("dragstart", onStart);
    document.removeEventListener("dragend", onEnd, true);
  };
}

/** What a dragover carries: a tree path, desktop files, or nothing we accept. */
export function dragKind(dt: { types: readonly string[] }): "path" | "files" | null {
  if (dt.types.includes(RESOURCE_MIME) || dt.types.includes(PATH_MIME)) return "path";
  if (dt.types.includes("Files")) return "files";
  return null;
}

/** Upload dropped desktop files into `dir` ("" = project/worktree root);
 *  returns their rel paths. */
export async function uploadFiles(
  projectId: string,
  dir: string,
  files: Iterable<File>,
  sessionId?: string,
  repositoryId?: string,
): Promise<string[]> {
  const paths: string[] = [];
  for (const f of files) {
    const rel = dir ? `${dir}/${f.name}` : f.name;
    await api.filesUpload(projectId, rel, new Uint8Array(await f.arrayBuffer()), sessionId, repositoryId);
    paths.push(rel);
  }
  return paths;
}

/** Drop onto the session: tree drags become pills directly; desktop files
 *  upload into _inbox/ first, then attach. Failures are reported per-file. */
export async function dropIntoSession(
  dt: DataTransfer,
  projectId: string,
  sessionId: string | null,
  onError?: (reason: string) => void,
): Promise<void> {
  if (dt.getData(RESOURCE_MIME)) {
    const ref = getDragResource(dt);
    if (!ref || ref.projectId !== projectId || (ref.sessionId ?? null) !== sessionId) {
      onError?.("This file belongs to a different workspace. Open that workspace to attach it.");
      return;
    }
    if (ref.context) {
      try {
        const state = getState();
        const project = state.projectRegistry.projects.find((row) => row.id === projectId);
        const session = sessionId ? state.sessions.find((row) => row.id === sessionId) : undefined;
        if (!project || (sessionId && !session) || !ref.repositoryId) throw new Error(tr("dnd.repositoryContextUnavailable"));
        const repository = workspaceRepository(resolveWorkspaceContext(project, session), ref.repositoryId);
        if (repository.state !== "ready") throw new Error(tr("dnd.checkoutUnavailable"));
        let text: string;
        let label: string;
        if (ref.context.kind === "working-changes") {
          const result = await api.gitDiff(projectId, ref.locator, ref.context.staged, false, sessionId ?? undefined, ref.repositoryId);
          if (ref.context.snapshotDigest && result.snapshotDigest !== ref.context.snapshotDigest) throw new Error(tr("dnd.changesMoved"));
          let patch = result.diff;
          if (ref.context.hunkDigest) {
            const digest = ref.context.hunkDigest;
            const hunk = splitHunks(patch).find((row) => hunkDigest(row) === digest);
            if (!hunk) throw new Error(tr("dnd.hunkGone"));
            patch = [hunk.header, ...hunk.body].join("\n");
          }
          if (!patch.trim()) throw new Error(tr("dnd.noMatchingChanges"));
          if (new TextEncoder().encode(patch).byteLength > 512 * 1024) throw new Error(tr("dnd.diffTooLarge"));
          label = `${repository.alias} · ${ref.locator.split("/").pop()} · ${ref.context.staged ? "staged" : "working"} changes.diff`;
          text = `Repository: ${repository.alias} (${ref.repositoryId})\nFile: ${ref.locator}\nContext: ${ref.context.staged ? "staged" : "working"} changes\nSnapshot: ${result.snapshotDigest}\n\n${patch}`;
        } else {
          const info = await api.filesStat(projectId, ref.locator, sessionId ?? undefined, ref.repositoryId);
          if (info.kind !== "dir") throw new Error(tr("dnd.directoryGone"));
          label = `${repository.alias} · ${ref.locator.split("/").pop()} · directory.txt`;
          text = `Directory reference\nRepository: ${repository.alias} (${ref.repositoryId})\nPath: ${ref.locator}/\nThis reference does not include directory contents. Inspect files within the authorized session workspace as needed.`;
        }
        const now = getState();
        if (now.activeProjectId !== projectId || (now.activeSessionId ?? null) !== sessionId) throw new Error(tr("dnd.workspaceChanged"));
        const result = await attachUpload(projectId, sessionId, new File([text], label, { type: "text/plain" }), label);
        if (!result.ok) onError?.(result.reason);
      } catch (error) { onError?.(error instanceof Error ? error.message : "Could not attach workspace context."); }
      return;
    }
    const range: [number, number] | undefined = ref.selection ? [ref.selection.startLine, ref.selection.endLine ?? ref.selection.startLine] : undefined;
    const state = getState();
    const project = state.projectRegistry.projects.find((row) => row.id === projectId);
    const session = sessionId ? state.sessions.find((row) => row.id === sessionId) : undefined;
    let displayName: string | undefined;
    if (project && (!sessionId || session) && ref.repositoryId) {
      try {
        const workspace = resolveWorkspaceContext(project, session);
        if (workspace.repositories.length > 1) displayName = `${workspaceRepository(workspace, ref.repositoryId).alias} · ${ref.locator.split("/").pop()}`;
      } catch { /* Attachment validation remains authoritative. */ }
    }
    const result = await attachProjectFile(projectId, sessionId, ref.locator, range, undefined, undefined, displayName, ref.repositoryId);
    if (!result.ok) onError?.(result.reason);
    return;
  }
  const p = getDragPath(dt);
  if (p) {
    const r = await attachProjectFile(projectId, sessionId, p);
    if (!r.ok) onError?.(r.reason);
    return;
  }
  for (const f of Array.from(dt.files)) {
    const r = await attachUpload(projectId, sessionId, f);
    if (!r.ok) onError?.(r.reason);
  }
}
