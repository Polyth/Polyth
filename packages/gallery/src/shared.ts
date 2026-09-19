// Browser-safe, dependency-free gallery model. Both the server route and the
// widget import this module: image classification, project-relative path
// normalization, annotation geometry, and the model-visible message format.
// Keeping it pure means the interesting rules are unit-testable without DOM
// or filesystem.

export const GALLERY_MAX_IMAGES = 400;
/** Mirrors the server's per-message attachment cap (attachments.ts). */
export const GALLERY_MAX_ATTACHMENTS = 16;
export const GALLERY_DEFAULT_INSTRUCTION = "Review these images and tell me what to improve.";

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** Lowercased extension without the dot, or "" when there is none. */
export function imageExtension(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function imageMimeOf(filePath: string): string | undefined {
  return IMAGE_MIME_BY_EXTENSION[imageExtension(filePath)];
}

export function isImagePath(filePath: string): boolean {
  return imageMimeOf(filePath) !== undefined;
}

export interface GalleryImage {
  /** Basename shown in the UI. */
  name: string;
  /** Project-relative POSIX path; the identity used for annotations. */
  path: string;
  size: number;
  mime: string;
}

export interface GalleryFolder {
  name: string;
  path: string;
}

export interface GalleryListing {
  /** Normalized project-relative folder that was listed. */
  path: string;
  parent: string | null;
  /** Immediate subfolders, so the picker can navigate without a second route. */
  folders: GalleryFolder[];
  images: GalleryImage[];
  /** True when the scan hit its directory or image bound. */
  truncated: boolean;
}

export interface GalleryAnnotation {
  id: string;
  kind: "point" | "rect";
  /** Normalized 0..1 within the image's natural box. */
  x: number;
  y: number;
  /** 0 for points. */
  w: number;
  h: number;
  comment: string;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Normalize a drag into a positive-size rect clipped to the image box. */
export function normalizeDragRect(input: {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}): { x: number; y: number; w: number; h: number } {
  const left = clamp01(Math.min(input.x0, input.x1));
  const top = clamp01(Math.min(input.y0, input.y1));
  const right = clamp01(Math.max(input.x0, input.x1));
  const bottom = clamp01(Math.max(input.y0, input.y1));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Reject degenerate drags so an accidental click in zone mode is not stored. */
export const GALLERY_MIN_RECT = 0.01;

const ANNOTATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

function normalizeAnnotation(value: unknown): GalleryAnnotation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" && ANNOTATION_ID.test(raw.id) ? raw.id : null;
  const kind = raw.kind === "rect" ? "rect" : raw.kind === "point" ? "point" : null;
  if (!id || !kind) return null;
  const x = clamp01(Number(raw.x));
  const y = clamp01(Number(raw.y));
  if (!Number.isFinite(Number(raw.x)) || !Number.isFinite(Number(raw.y))) return null;
  const w = kind === "rect" ? clamp01(Number(raw.w)) : 0;
  const h = kind === "rect" ? clamp01(Number(raw.h)) : 0;
  const comment = typeof raw.comment === "string" ? raw.comment.slice(0, 4000) : "";
  return { id, kind, x, y, w, h, comment };
}

/** Sanitize annotations loaded from local persistence. Unknown fields drop. */
export function parseAnnotations(value: unknown): GalleryAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeAnnotation)
    .filter((item): item is GalleryAnnotation => item !== null);
}

export function annotationForImage(
  byImage: Readonly<Record<string, readonly GalleryAnnotation[]>>,
  imagePath: string,
): readonly GalleryAnnotation[] {
  return byImage[imagePath] ?? [];
}

const percent = (value: number): string => `${(clamp01(value) * 100).toFixed(1)}%`;

export function describeAnnotation(annotation: GalleryAnnotation): string {
  if (annotation.kind === "point") {
    return `point at ${percent(annotation.x)} × ${percent(annotation.y)}`;
  }
  const right = annotation.x + annotation.w;
  const bottom = annotation.y + annotation.h;
  return `zone x ${percent(annotation.x)}–${percent(right)}, y ${percent(annotation.y)}–${percent(bottom)}`;
}

export interface GalleryMessageImage {
  path: string;
  name: string;
  annotations: readonly GalleryAnnotation[];
}

export interface GalleryMessageInput {
  folder: string;
  instruction: string;
  images: readonly GalleryMessageImage[];
}

/** Compose the model-visible prompt. Coordinates are normalized so they stay
 *  meaningful regardless of the image's pixel size. */
export function buildGalleryMessage(input: GalleryMessageInput): string {
  const folder = input.folder ? input.folder : "project root";
  const lines: string[] = [
    `Gallery review — ${folder} (${input.images.length} image${input.images.length === 1 ? "" : "s"})`,
  ];
  const instruction = input.instruction.trim();
  if (instruction) lines.push("", instruction);
  lines.push("", "Attached images:");
  input.images.forEach((image, index) => {
    lines.push(`${index + 1}. ${image.name} (\`${image.path}\`)`);
    if (image.annotations.length === 0) {
      lines.push("   (no notes)");
      return;
    }
    for (const annotation of image.annotations) {
      const comment = annotation.comment.trim();
      lines.push(`   - ${describeAnnotation(annotation)}${comment ? `: ${comment}` : ""}`);
    }
  });
  return lines.join("\n");
}

/** Normalize a project-relative folder. Returns null when unsafe. */
export function normalizeGalleryPath(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value || value === "." || value === "/") return "";
  if (value.includes("\\") || value.includes("\0")) return null;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments.join("/");
}

export function parentGalleryPath(folder: string): string | null {
  const normalized = normalizeGalleryPath(folder);
  if (normalized === null || normalized === "") return null;
  const cut = normalized.lastIndexOf("/");
  return cut < 0 ? "" : normalized.slice(0, cut);
}

export function joinGalleryPath(folder: string, name: string): string {
  const normalized = normalizeGalleryPath(folder) ?? "";
  return normalized ? `${normalized}/${name}` : name;
}

export function galleryFolderLabel(folder: string): string {
  const normalized = normalizeGalleryPath(folder);
  if (normalized === null || normalized === "") return "Project root";
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? normalized;
}

/** Clickable ancestry for the folder picker: [{ label: "raw", path: "outputs/raw" }, …]. */
export function galleryPathCrumbs(folder: string): Array<{ label: string; path: string }> {
  const normalized = normalizeGalleryPath(folder);
  if (normalized === null || normalized === "") return [];
  const crumbs: Array<{ label: string; path: string }> = [];
  let accumulated = "";
  for (const segment of normalized.split("/")) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    crumbs.push({ label: segment, path: accumulated });
  }
  return crumbs;
}
