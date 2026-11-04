// Re-encode an inline image so it fits a size budget, sharpest first. JPEG,
// because iOS canvases cannot encode WebP and silently hand back a PNG. JPEG has
// no alpha, so transparency lands on what the page currently sits over.

export interface ShrinkLadder {
  /** Longest edge in px, tried from sharpest down. An image is never scaled up. */
  edges: readonly number[];
  qualities: readonly number[];
}

const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,".length;

/** The first encoding on the ladder within `maxBytes`, or null when none fits. */
export async function shrinkToBudget<T extends { size: number }>(
  longEdge: number,
  encode: (edge: number, quality: number) => Promise<T | null>,
  maxBytes: number,
  ladder: ShrinkLadder,
): Promise<T | null> {
  for (const edge of new Set(ladder.edges.map((candidate) => Math.min(candidate, longEdge)))) {
    for (const quality of ladder.qualities) {
      const encoded = await encode(edge, quality);
      if (encoded && encoded.size <= maxBytes) return encoded;
    }
  }
  return null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the re-encoded image"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

/** `image` as a data URL of at most `maxChars`, or null when it cannot be made.
 *  An image that already fits stays exactly as it is. */
export async function shrinkImage(image: string, maxChars: number, ladder: ShrinkLadder): Promise<string | null> {
  if (image.length <= maxChars) return image;
  const source = new Image();
  source.src = image;
  await source.decode();
  const { naturalWidth: width, naturalHeight: height } = source;
  const longEdge = Math.max(width, height);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context || longEdge === 0) return null;
  const backdrop = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#000";
  // Base64 turns 3 bytes into 4 characters, rounded up to a whole group.
  const maxBytes = Math.floor((maxChars - JPEG_DATA_URL_PREFIX - 4) * 3 / 4);
  const blob = await shrinkToBudget(longEdge, (edge, quality) => {
    canvas.width = Math.max(1, Math.round(width * edge / longEdge));
    canvas.height = Math.max(1, Math.round(height * edge / longEdge));
    context.imageSmoothingQuality = "high";
    context.fillStyle = backdrop;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }, maxBytes, ladder);
  return blob ? blobToDataUrl(blob) : null;
}
