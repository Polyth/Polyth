import { parseAnnotations, type GalleryAnnotation } from "../src/shared.ts";

/** Notes are browser-local presentation state until they are sent. They are
 *  keyed by project so switching projects never mixes reviews, and reads are
 *  sanitized so a corrupted store cannot crash the widget. */
const STORAGE_PREFIX = "polyth.gallery.notes.";

export type AnnotationsByImage = Record<string, GalleryAnnotation[]>;

export function loadAnnotations(projectId: string | null): AnnotationsByImage {
  if (!projectId || typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + projectId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: AnnotationsByImage = {};
    for (const [imagePath, value] of Object.entries(parsed)) {
      const annotations = parseAnnotations(value);
      if (annotations.length > 0) out[imagePath] = annotations;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveAnnotations(projectId: string | null, byImage: AnnotationsByImage): void {
  if (!projectId || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(byImage));
  } catch {
    // Private mode / quota: notes stay in memory for this session.
  }
}

export function newAnnotationId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
