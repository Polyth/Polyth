import { createApiTransport } from "@polyth/web-sdk";
import type { AttachmentRef } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import type { GalleryListing } from "../src/shared.ts";

const transport = createApiTransport();

export interface ListGalleryRequest {
  projectId: string;
  sessionId: string | null;
  folder: string;
  recursive: boolean;
  signal?: AbortSignal;
}

export async function fetchGalleryListing(input: ListGalleryRequest): Promise<GalleryListing> {
  const params = new URLSearchParams({
    projectId: input.projectId,
    path: input.folder,
    recursive: String(input.recursive),
  });
  if (input.sessionId) params.set("sessionId", input.sessionId);
  return transport.get<GalleryListing>(`/api/gallery/images?${params.toString()}`, {
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export interface GalleryAttachmentInput {
  projectId: string;
  sessionId: string | null;
  path: string;
  name: string;
  mime: string;
  size: number;
}

export function galleryAttachment(input: GalleryAttachmentInput): AttachmentRef {
  return {
    // Server-side attachment ids are capped at 100 chars; the path can be long,
    // so identity is generated rather than derived from it.
    id: newClientOperationId(),
    name: input.name,
    mime: input.mime,
    size: input.size,
    kind: "image",
    path: input.path,
    url: api.filesRawUrl(input.projectId, input.path, input.sessionId ?? undefined),
  };
}

export function newClientOperationId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  return `gallery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
