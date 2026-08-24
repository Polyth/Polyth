export const BROWSER_DEVICE_PRESETS = [
  { id: "responsive", label: "Responsive", width: 1280, height: 800 },
  { id: "iphone-14", label: "iPhone 14", width: 390, height: 844 },
  { id: "pixel-7", label: "Pixel 7", width: 412, height: 915 },
  { id: "ipad-mini", label: "iPad mini", width: 768, height: 1024 },
  { id: "laptop", label: "Laptop", width: 1366, height: 768 },
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
] as const;

export type BrowserDevicePresetId = typeof BROWSER_DEVICE_PRESETS[number]["id"];

export interface BrowserAnnotation {
  id: number;
  /** Normalized coordinates keep a selected area tied to the captured frame. */
  x: number;
  y: number;
  width: number;
  height: number;
  note: string;
}

export interface BrowserPointedElement {
  selector: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  rect: { x: number; y: number; width: number; height: number };
  attributes?: Record<string, string>;
}

/** Model-facing text paired with the pointed-element screenshot attachment. */
export function browserElementContext(url: string, element: BrowserPointedElement): string {
  return [
    "[Browser element]",
    `URL: ${url}`,
    `Selector: ${element.selector}`,
    `Element: <${element.tag}>${element.role ? ` role="${element.role}"` : ""}${element.name ? ` name="${element.name}"` : ""}`,
    element.text ? `Text: ${element.text}` : "",
    `Bounds: x=${element.rect.x}, y=${element.rect.y}, width=${element.rect.width}, height=${element.rect.height}`,
  ].filter(Boolean).join("\n");
}

export interface ImageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (value: number, min = 0, max = 1): number =>
  Math.max(min, Math.min(max, value));

export function devicePresetForViewport(width: number, height: number): BrowserDevicePresetId {
  return BROWSER_DEVICE_PRESETS.find((preset) => preset.width === width && preset.height === height)?.id
    ?? "responsive";
}

/** Bounds of an object-fit:contain image inside its element. */
export function containedImageRect(
  elementWidth: number,
  elementHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): ImageRect {
  if (elementWidth <= 0 || elementHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(elementWidth / sourceWidth, elementHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    left: (elementWidth - width) / 2,
    top: (elementHeight - height) / 2,
    width,
    height,
  };
}

export function normalizedPointInImage(
  x: number,
  y: number,
  rect: ImageRect,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (x < rect.left || y < rect.top || x > rect.left + rect.width || y > rect.top + rect.height) return null;
  return {
    x: clamp((x - rect.left) / rect.width),
    y: clamp((y - rect.top) / rect.height),
  };
}

/** Normalize a drag selection and clamp it to the object-fit image bounds. */
export function normalizedRectInImage(
  start: { x: number; y: number },
  end: { x: number; y: number },
  rect: ImageRect,
): Omit<BrowserAnnotation, "id" | "note"> | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const left = clamp(Math.min(start.x, end.x), rect.left, rect.left + rect.width);
  const top = clamp(Math.min(start.y, end.y), rect.top, rect.top + rect.height);
  const right = clamp(Math.max(start.x, end.x), rect.left, rect.left + rect.width);
  const bottom = clamp(Math.max(start.y, end.y), rect.top, rect.top + rect.height);
  if (right - left < 4 || bottom - top < 4) return null;
  return {
    x: (left - rect.left) / rect.width,
    y: (top - rect.top) / rect.height,
    width: (right - left) / rect.width,
    height: (bottom - top) / rect.height,
  };
}

export function annotationViewportRect(
  annotation: Pick<BrowserAnnotation, "x" | "y" | "width" | "height">,
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x = Math.round(clamp(annotation.x) * viewport.width);
  const y = Math.round(clamp(annotation.y) * viewport.height);
  const right = Math.round(clamp(annotation.x + annotation.width) * viewport.width);
  const bottom = Math.round(clamp(annotation.y + annotation.height) * viewport.height);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

export function captureFileName(now = new Date()): string {
  return `browser-${now.toISOString().replace(/[:.]/g, "-")}.png`;
}

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Couldn’t decode the current browser frame."));
    image.src = src;
  });

/** Paint selected rectangles and their comments into the screenshot uploaded to chat. */
export async function renderBrowserCapture(
  src: string,
  annotations: readonly BrowserAnnotation[],
  fileName = captureFileName(),
): Promise<File> {
  const image = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  if (!context || canvas.width <= 0 || canvas.height <= 0) {
    throw new Error("Couldn’t prepare the browser capture.");
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const unit = Math.max(12, Math.round(Math.min(canvas.width, canvas.height) * 0.022));
  context.font = `600 ${Math.max(13, Math.round(unit * 0.82))}px ui-sans-serif, system-ui, sans-serif`;
  context.textBaseline = "middle";
  annotations.forEach((annotation, index) => {
    const x = clamp(annotation.x) * canvas.width;
    const y = clamp(annotation.y) * canvas.height;
    const width = Math.max(1, clamp(annotation.width, 0, 1 - clamp(annotation.x)) * canvas.width);
    const height = Math.max(1, clamp(annotation.height, 0, 1 - clamp(annotation.y)) * canvas.height);
    const number = String(index + 1);

    context.save();
    context.fillStyle = "rgba(229, 72, 77, 0.12)";
    context.fillRect(x, y, width, height);
    context.lineWidth = Math.max(3, unit * 0.18);
    context.strokeStyle = "#e5484d";
    context.strokeRect(x, y, width, height);
    context.restore();

    const pinX = clamp(x + unit * 0.15, unit, canvas.width - unit);
    const pinY = clamp(y + unit * 0.15, unit, canvas.height - unit);
    context.beginPath();
    context.arc(pinX, pinY, unit, 0, Math.PI * 2);
    context.fillStyle = "#e5484d";
    context.fill();
    context.lineWidth = Math.max(2, unit * 0.15);
    context.strokeStyle = "#ffffff";
    context.stroke();
    context.fillStyle = "#ffffff";
    context.textAlign = "center";
    context.fillText(number, pinX, pinY + 0.5);

    const note = annotation.note.trim();
    if (!note) return;
    const text = note.slice(0, 120);
    const padding = Math.max(6, Math.round(unit * 0.45));
    const textWidth = context.measureText(text).width;
    const labelWidth = Math.min(canvas.width - padding * 2, textWidth + padding * 2);
    const labelHeight = unit * 1.55;
    const proposedX = pinX + unit * 1.35;
    const labelX = clamp(proposedX, padding, Math.max(padding, canvas.width - labelWidth - padding));
    const labelY = clamp(pinY - labelHeight / 2, padding, Math.max(padding, canvas.height - labelHeight - padding));
    context.fillStyle = "rgba(17, 18, 20, 0.9)";
    context.fillRect(labelX, labelY, labelWidth, labelHeight);
    context.fillStyle = "#ffffff";
    context.textAlign = "left";
    context.save();
    context.beginPath();
    context.rect(labelX + padding, labelY, labelWidth - padding * 2, labelHeight);
    context.clip();
    context.fillText(text, labelX + padding, labelY + labelHeight / 2);
    context.restore();
  });

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error("Couldn’t encode the browser capture."));
    }, "image/png");
  });
  return new File([blob], fileName, { type: "image/png" });
}
