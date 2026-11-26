// Marks drawn on a report's screenshot: arrows, boxes, free pen lines and
// one crop. Everything is kept in the screenshot's own pixels, so the editor
// can be reopened and the marks moved to a different scale; `drawMarks`
// burns them into the image that is sent. No DOM here: the canvas context is
// structural, so the geometry is tested in Node.

export type MarkTool = "arrow" | "box" | "pen" | "crop";

export interface Point {
  x: number;
  y: number;
}

export type Mark =
  | { kind: "arrow"; color: string; from: Point; to: Point }
  | { kind: "box"; color: string; from: Point; to: Point }
  | { kind: "pen"; color: string; points: Point[] }
  | { kind: "crop"; from: Point; to: Point };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The colours the toolbar offers, first is the default: red reads on light
 *  and dark screens alike. Content colours, not theme tokens: they are burnt
 *  into the image. */
export const MARK_COLORS = ["#ff3b30", "#ff9500", "#34c759", "#0a84ff", "#ffffff", "#111111"] as const;

/** Shorter than this (screenshot pixels) is a click, not a mark. */
export const MIN_MARK = 4;
/** A crop narrower than this on either side is ignored. */
export const MIN_CROP = 16;

/** Stroke width for an image: thick enough to read once the relay's viewer
 *  shrinks it, never hairline on a small paste. */
export function strokeFor(width: number, height: number): number {
  return Math.max(3, Math.round(Math.max(width, height) / 240));
}

export const clampPoint = (point: Point, width: number, height: number): Point => ({
  x: Math.min(width, Math.max(0, point.x)),
  y: Math.min(height, Math.max(0, point.y)),
});

export function rectOf(from: Point, to: Point): Rect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** Whether a mark carries enough to keep (a stray click draws nothing). */
export function isMeaningful(mark: Mark): boolean {
  if (mark.kind === "pen") {
    if (mark.points.length < 2) return false;
    const first = mark.points[0]!;
    return mark.points.some((point) => Math.hypot(point.x - first.x, point.y - first.y) >= MIN_MARK);
  }
  if (mark.kind === "crop") {
    const rect = rectOf(mark.from, mark.to);
    return rect.width >= MIN_CROP && rect.height >= MIN_CROP;
  }
  if (mark.kind === "box") {
    const rect = rectOf(mark.from, mark.to);
    return rect.width >= MIN_MARK && rect.height >= MIN_MARK;
  }
  return Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y) >= MIN_MARK;
}

/** The crop in force: the last one drawn (undo brings back the one before),
 *  rounded to whole pixels; null keeps the whole screenshot. */
export function activeCrop(marks: readonly Mark[], width: number, height: number): Rect | null {
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index]!;
    if (mark.kind !== "crop") continue;
    const from = clampPoint(mark.from, width, height);
    const to = clampPoint(mark.to, width, height);
    const x = Math.round(Math.min(from.x, to.x));
    const y = Math.round(Math.min(from.y, to.y));
    const rect = {
      x,
      y,
      width: Math.round(Math.max(from.x, to.x)) - x,
      height: Math.round(Math.max(from.y, to.y)) - y,
    };
    return rect.width >= MIN_CROP && rect.height >= MIN_CROP ? rect : null;
  }
  return null;
}

/** The arrow's shaft end and head triangle: the shaft stops at the head's
 *  base, so a thick line never pokes through the point. A short arrow gets a
 *  head that fits it. */
export function arrowGeometry(from: Point, to: Point, stroke: number): { shaftEnd: Point; head: [Point, Point, Point] } {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const ux = length > 0 ? (to.x - from.x) / length : 1;
  const uy = length > 0 ? (to.y - from.y) / length : 0;
  const headLength = Math.min(Math.max(stroke * 4.5, 14), length * 0.6);
  const halfWidth = headLength * 0.55;
  const base = { x: to.x - ux * headLength, y: to.y - uy * headLength };
  return {
    shaftEnd: { x: to.x - ux * headLength * 0.8, y: to.y - uy * headLength * 0.8 },
    head: [
      { x: to.x, y: to.y },
      { x: base.x - uy * halfWidth, y: base.y + ux * halfWidth },
      { x: base.x + uy * halfWidth, y: base.y - ux * halfWidth },
    ],
  };
}

/** The part of a 2D canvas context the marks use. */
export interface MarkContext {
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, width: number, height: number): void;
  stroke(): void;
  fill(): void;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  shadowColor: string;
  shadowBlur: number;
}

/** Draw the visible marks (crops are not drawn: they cut the image) in the
 *  screenshot's own coordinates. A soft shadow keeps white and black marks
 *  readable on any background. */
export function drawMarks(context: MarkContext, marks: readonly Mark[], stroke: number): void {
  for (const mark of marks) {
    if (mark.kind === "crop") continue;
    context.save();
    context.lineWidth = stroke;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = mark.color;
    context.fillStyle = mark.color;
    context.shadowColor = mark.color === MARK_COLORS[5] ? "rgba(255, 255, 255, 0.55)" : "rgba(0, 0, 0, 0.35)";
    context.shadowBlur = stroke * 1.2;
    context.beginPath();
    if (mark.kind === "pen") {
      const [first, ...rest] = mark.points;
      if (first) {
        context.moveTo(first.x, first.y);
        for (const point of rest) context.lineTo(point.x, point.y);
      }
      context.stroke();
    } else if (mark.kind === "box") {
      const rect = rectOf(mark.from, mark.to);
      context.rect(rect.x, rect.y, rect.width, rect.height);
      context.stroke();
    } else {
      const { shaftEnd, head } = arrowGeometry(mark.from, mark.to, stroke);
      context.moveTo(mark.from.x, mark.from.y);
      context.lineTo(shaftEnd.x, shaftEnd.y);
      context.stroke();
      context.beginPath();
      context.moveTo(head[0].x, head[0].y);
      context.lineTo(head[1].x, head[1].y);
      context.lineTo(head[2].x, head[2].y);
      context.closePath();
      context.fill();
    }
    context.restore();
  }
}

/** Append a pen point unless it is closer than a pixel to the last one: a
 *  long scribble stays small. */
export function extendPen(points: readonly Point[], next: Point): Point[] {
  const last = points[points.length - 1];
  if (last && Math.hypot(next.x - last.x, next.y - last.y) < 1) return points as Point[];
  return [...points, next];
}
