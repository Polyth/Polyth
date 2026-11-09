// How large a photo goes up. A phone photo is several megabytes while models
// downscale to about 1600-2000 px anyway, so the browser offers smaller copies
// before anything leaves the device. A re-encoded copy also carries no EXIF, so
// it drops the location and camera details the original holds.

export const IMAGE_UPLOAD_PRESETS = {
  small: { edge: 1024, quality: 0.8 },
  medium: { edge: 1600, quality: 0.82 },
  large: { edge: 2560, quality: 0.85 },
} as const;

export type ImageUploadPreset = keyof typeof IMAGE_UPLOAD_PRESETS;
export type ImageUploadSize = ImageUploadPreset | "original";
export type ImageUploadPreference = ImageUploadSize | "ask";

/** Smallest first; an option is compared with the one before it. */
export const IMAGE_UPLOAD_PRESET_IDS: readonly ImageUploadPreset[] = ["small", "medium", "large"];

/** Smaller files go up without a question: there is little to save on them. */
export const ASK_IMAGE_SIZE_ABOVE_BYTES = 1024 * 1024;

// Formats a browser can decode and a canvas can redraw without losing anything
// the format is for. GIF would lose its animation and SVG its vectors.
const RESIZABLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic", "image/heif", "image/bmp", "image/tiff"]);
const OPAQUE_TYPES = new Set(["image/jpeg", "image/heic", "image/heif"]);

export function parseImageUploadPreference(value: unknown): ImageUploadPreference {
  return value === "small" || value === "medium" || value === "large" || value === "original" ? value : "ask";
}

export function isResizableImage(file: Pick<File, "type">): boolean {
  return RESIZABLE_TYPES.has(file.type.toLowerCase());
}

export function shouldAskImageSize(file: Pick<File, "type" | "size">): boolean {
  return isResizableImage(file) && file.size > ASK_IMAGE_SIZE_ABOVE_BYTES;
}

/** A photo already within the preset's edge is only re-encoded when it is heavy:
 *  redrawing a light screenshot would blur its text and save nothing. */
export function presetKeepsOriginal(file: Pick<File, "size">, longEdge: number, preset: ImageUploadPreset): boolean {
  return longEdge <= IMAGE_UPLOAD_PRESETS[preset].edge && file.size <= ASK_IMAGE_SIZE_ABOVE_BYTES;
}

export function reducedImageName(name: string, type: string): string {
  const stem = name.replace(/\.[^./\\]+$/, "") || "photo";
  return `${stem}.${type === "image/png" ? "png" : "jpg"}`;
}

export interface ImageVariants {
  /** 0 when the browser could not decode the file. */
  longEdge: number;
  /** Each preset's copy, or the file itself when no copy would be smaller. */
  variants: Partial<Record<ImageUploadPreset, File>>;
}

export type ImageVariantEncoder = (file: File, presets: readonly ImageUploadPreset[]) => Promise<ImageVariants>;

function hasTransparency(source: HTMLImageElement, width: number, height: number): boolean {
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 256 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 3; index < data.length; index += 4) {
    if (data[index]! < 250) return true;
  }
  return false;
}

/** The copies of `file` for `presets`. JPEG because iOS canvases cannot encode
 *  WebP; a transparent image stays PNG so its background does not turn solid.
 *  A file the browser cannot decode (HEIC outside Safari) comes back unchanged. */
export async function encodeImageVariants(file: File, presets: readonly ImageUploadPreset[]): Promise<ImageVariants> {
  const unchanged = (longEdge: number): ImageVariants => ({
    longEdge,
    variants: Object.fromEntries(presets.map((preset) => [preset, file])),
  });
  const url = URL.createObjectURL(file);
  try {
    const source = new Image();
    source.src = url;
    await source.decode();
    const { naturalWidth: width, naturalHeight: height } = source;
    const longEdge = Math.max(width, height);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context || longEdge === 0) return unchanged(0);
    const type = OPAQUE_TYPES.has(file.type.toLowerCase()) || !hasTransparency(source, width, height) ? "image/jpeg" : "image/png";
    const variants: ImageVariants["variants"] = {};
    for (const preset of presets) {
      if (presetKeepsOriginal(file, longEdge, preset)) {
        variants[preset] = file;
        continue;
      }
      const { edge, quality } = IMAGE_UPLOAD_PRESETS[preset];
      const scale = Math.min(edge, longEdge) / longEdge;
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.imageSmoothingQuality = "high";
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
      variants[preset] = blob && blob.size < file.size
        ? new File([blob], reducedImageName(file.name, type), { type, lastModified: file.lastModified })
        : file;
    }
    // iOS holds a canvas's backing store until it is resized.
    canvas.width = 0;
    canvas.height = 0;
    return { longEdge, variants };
  } catch {
    return unchanged(0);
  } finally {
    URL.revokeObjectURL(url);
  }
}

let encodeChain: Promise<unknown> = Promise.resolve();

/** One photo at a time: a decoded 12 MP photo holds about 48 MB, and a phone
 *  reloads the page when a batch of them is decoded at once. */
export const encodeImageVariantsInTurn: ImageVariantEncoder = (file, presets) => {
  const run = encodeChain.then(() => encodeImageVariants(file, presets));
  encodeChain = run.catch(() => undefined);
  return run;
};

export interface ImageSizeItem {
  file: Pick<File, "size">;
  longEdge?: number;
  variants?: ImageVariants["variants"];
}

export interface ImageSizeOption {
  id: ImageUploadSize;
  /** Longest edge, when it is one number for the whole batch. */
  edge: number | null;
  /** Total upload, or null until a first photo has been measured. */
  bytes: number | null;
  /** The total extrapolates from the photos measured so far. */
  approximate: boolean;
}

/** The choices worth showing for a batch. A preset that would change nothing
 *  disappears: one larger than every photo repeats the preset below it. */
export function imageSizeOptions(items: readonly ImageSizeItem[]): ImageSizeOption[] {
  const originalBytes = items.reduce((total, item) => total + item.file.size, 0);
  const measured = items.filter((item) => item.variants);
  const edges = measured.map((item) => item.longEdge ?? 0);
  const longest = edges.length === items.length && edges.length > 0 ? Math.max(...edges) : null;
  const single = items.length === 1 ? longest : null;
  const options: ImageSizeOption[] = [];
  IMAGE_UPLOAD_PRESET_IDS.forEach((id, index) => {
    const previous = IMAGE_UPLOAD_PRESET_IDS[index - 1];
    if (previous && longest !== null && longest <= IMAGE_UPLOAD_PRESETS[previous].edge) return;
    const known = measured.reduce((total, item) => total + (item.variants?.[id]?.size ?? item.file.size), 0);
    const bytes = measured.length === 0 ? null : Math.round(known * items.length / measured.length);
    if (longest !== null && bytes !== null && bytes >= originalBytes) return;
    const edge = IMAGE_UPLOAD_PRESETS[id].edge;
    options.push({
      id,
      edge: single !== null ? Math.min(edge, single) : edge,
      bytes,
      approximate: measured.length < items.length,
    });
  });
  options.push({ id: "original", edge: single, bytes: originalBytes, approximate: false });
  return options;
}

/** Medium when it is on offer, otherwise the nearest smaller choice. */
export function recommendedImageSize(options: readonly ImageSizeOption[]): ImageUploadSize {
  return options.find((option) => option.id === "medium")?.id ?? options[0]!.id;
}

export function formatImageBytes(bytes: number, locale: string): string {
  const megabytes = bytes >= 1000 * 1000;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: megabytes ? "megabyte" : "kilobyte",
    unitDisplay: "short",
    maximumFractionDigits: megabytes ? 1 : 0,
  }).format(megabytes ? bytes / (1000 * 1000) : Math.max(1, bytes / 1000));
}
