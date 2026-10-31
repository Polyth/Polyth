import type { FileReadResult } from "@polyth/session/web-api";
import type { ResourceDocumentHandle, ResourceRef } from "@polyth/web-sdk";
import { resourceKey } from "@polyth/web-sdk";
import {
  deleteDocument,
  documentsVersion,
  fileRef,
  installDocumentUnloadGuard,
  isDocumentDirty,
  isDocumentEditing,
  openDocument,
  peekDocument,
  removeDocument,
  renameDocument,
  resetDocumentsForTest,
  setDocumentEditing,
  subscribeDocuments,
  documentSessionCount,
} from "../../../../apps/web/src/resources/documents.ts";

export interface FileDoc {
  handle: ResourceDocumentHandle;
  get buf(): string;
  get editing(): boolean;
  set editing(value: boolean);
  get loading(): boolean;
  get error(): string;
  get live(): ReturnType<ResourceDocumentHandle["getSnapshot"]>["live"];
  get composing(): boolean;
  get doc(): FileReadResult | null;
}

export function docScopeKey(projectId: string, sessionId: string | null, repositoryId?: string): string {
  return `${projectId}:${sessionId ?? "project"}:${repositoryId ?? "primary"}`;
}

function asFileDoc(handle: ResourceDocumentHandle, path: string): FileDoc {
  return {
    handle,
    get buf() { return handle.getBuffer(); },
    get editing() { return isDocumentEditing(handle.ref); },
    set editing(value: boolean) { setDocumentEditing(handle.ref, value); },
    get loading() {
      const status = handle.getSnapshot().status;
      return status === "loading" || status === "idle";
    },
    get error() { return handle.getSnapshot().error; },
    get live() { return handle.getSnapshot().live; },
    get composing() { return handle.getSnapshot().composing; },
    get doc() {
      const snap = handle.getSnapshot();
      if (snap.status !== "ready") return null;
      return {
        path,
        content: snap.saved,
        truncated: snap.truncated,
        tooLarge: snap.binary,
        revision: snap.revision,
      } as FileReadResult;
    },
  };
}

export const subscribeDocs = subscribeDocuments;
export const docsVersion = documentsVersion;
export const installDocUnloadGuard = installDocumentUnloadGuard;
export const resetDocsForTest = resetDocumentsForTest;
export const sessionCount = documentSessionCount;

export function openFileDoc(projectId: string, sessionId: string | null, path: string, repositoryId?: string): ResourceDocumentHandle {
  return openDocument(fileRef(projectId, sessionId, path, repositoryId));
}

export function peekFileDoc(projectId: string, sessionId: string | null, path: string, repositoryId?: string): FileDoc | null {
  const handle = peekDocument(fileRef(projectId, sessionId, path, repositoryId));
  return handle ? asFileDoc(handle, path) : null;
}

export function deleteDoc(projectId: string, sessionId: string | null, path: string, repositoryId?: string): void | Promise<void> {
  return deleteDocument(fileRef(projectId, sessionId, path, repositoryId));
}

export function moveDoc(projectId: string, sessionId: string | null, from: string, to: string, repositoryId?: string): void | Promise<void> {
  return peekDocument(fileRef(projectId, sessionId, from, repositoryId))?.moveTo(fileRef(projectId, sessionId, to, repositoryId));
}

export function renameDoc(projectId: string, sessionId: string | null, from: string, to: string, repositoryId?: string): Promise<void> {
  return renameDocument(fileRef(projectId, sessionId, from, repositoryId), to);
}

export function removeDoc(projectId: string, sessionId: string | null, path: string, repositoryId?: string): Promise<void> {
  return removeDocument(fileRef(projectId, sessionId, path, repositoryId));
}

export function isDocDirty(projectId: string, sessionId: string | null, path: string, repositoryId?: string): boolean {
  return isDocumentDirty(fileRef(projectId, sessionId, path, repositoryId));
}

export function fileDocKey(projectId: string, sessionId: string | null, path: string, repositoryId?: string): string {
  return resourceKey(fileRef(projectId, sessionId, path, repositoryId));
}

export function fileResourceRef(projectId: string, sessionId: string | null, path: string, repositoryId?: string): ResourceRef {
  return fileRef(projectId, sessionId, path, repositoryId);
}
