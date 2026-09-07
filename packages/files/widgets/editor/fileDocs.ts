import type { FileReadResult } from "@polyth/session/web-api";
import type { ResourceDocumentHandle } from "@polyth/web-sdk";
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
  resetDocumentsForTest,
  setDocumentEditing,
  subscribeDocuments,
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

export function docScopeKey(projectId: string, sessionId: string | null): string {
  return `${projectId}:${sessionId ?? "project"}`;
}

function parseScope(scope: string): { projectId: string; sessionId: string | null } {
  const split = scope.indexOf(":");
  const projectId = split < 0 ? scope : scope.slice(0, split);
  const rest = split < 0 ? "project" : scope.slice(split + 1);
  return { projectId, sessionId: rest === "project" ? null : rest };
}

function handleFor(scope: string, path: string): ResourceDocumentHandle {
  const { projectId, sessionId } = parseScope(scope);
  return openDocument(fileRef(projectId, sessionId, path));
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

export function bumpDocs(): void {}
export const subscribeDocs = subscribeDocuments;
export const docsVersion = documentsVersion;
export const installDocUnloadGuard = installDocumentUnloadGuard;
export const resetDocsForTest = resetDocumentsForTest;

export function ensureDoc(scope: string, path: string): FileDoc {
  return asFileDoc(handleFor(scope, path), path);
}

export function deleteDoc(scope: string, path: string): void {
  const { projectId, sessionId } = parseScope(scope);
  deleteDocument(fileRef(projectId, sessionId, path));
}

export function moveDoc(scope: string, from: string, to: string): void {
  const { projectId, sessionId } = parseScope(scope);
  peekDocument(fileRef(projectId, sessionId, from))?.moveTo(fileRef(projectId, sessionId, to));
}

export function isDocDirty(scope: string, path: string): boolean {
  const { projectId, sessionId } = parseScope(scope);
  return isDocumentDirty(fileRef(projectId, sessionId, path));
}

export function fileDocKey(projectId: string, sessionId: string | null, path: string): string {
  return resourceKey(fileRef(projectId, sessionId, path));
}
