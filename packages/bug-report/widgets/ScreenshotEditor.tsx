// Marking up the report's screenshot: arrows, boxes, a pen and a crop, in one
// of six colours, with undo. The marks stay in the screenshot's own pixels
// (src/annotate.ts) over the untouched original, so reopening the editor
// changes them instead of drawing over burnt-in ones. `composeMarked` burns
// them into the JPEG that is sent.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { BugReportMessageKey } from "../src/i18n/en.ts";
import {
  MARK_COLORS,
  activeCrop,
  clampPoint,
  drawMarks,
  extendPen,
  isMeaningful,
  rectOf,
  strokeFor,
  type Mark,
  type MarkTool,
  type Point,
} from "../src/annotate.ts";

export interface MarkImage {
  dataUrl: string;
  width: number;
  height: number;
}

type Translate = (key: BugReportMessageKey) => string;

const COLOR_KEYS: Record<(typeof MARK_COLORS)[number], BugReportMessageKey> = {
  "#ff3b30": "bugreport.colorRed",
  "#ff9500": "bugreport.colorOrange",
  "#34c759": "bugreport.colorGreen",
  "#0a84ff": "bugreport.colorBlue",
  "#ffffff": "bugreport.colorWhite",
  "#111111": "bugreport.colorBlack",
};

// Tool glyphs: the host icon set has no drawing tools, so these four (and
// undo) are drawn here in its 24-unit, 1.75 stroke style.
const glyph = (body: ReactNode) => () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {body}
  </svg>
);
const TOOL_GLYPHS: Record<MarkTool, () => ReactNode> = {
  arrow: glyph(<><path d="M5 19 19 5" /><path d="M10 5h9v9" /></>),
  box: glyph(<rect x="4.5" y="5.5" width="15" height="13" rx="1.5" />),
  pen: glyph(<><path d="M14.5 5.5l4 4L9 19H5v-4z" /><path d="M12.5 7.5l4 4" /></>),
  crop: glyph(<><path d="M7 3v14h14" /><path d="M3 7h14v14" /></>),
};
const UndoGlyph = glyph(<><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>);

const TOOLS: Array<{ tool: MarkTool; label: BugReportMessageKey }> = [
  { tool: "crop", label: "bugreport.toolCrop" },
  { tool: "pen", label: "bugreport.toolPen" },
  { tool: "box", label: "bugreport.toolBox" },
  { tool: "arrow", label: "bugreport.toolArrow" },
];

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("image did not load"));
  image.src = src;
});

/** The original with its marks burnt in and its crop applied, as a JPEG the
 *  bridge re-encodes to the wire's limits; null when nothing could be drawn. */
export async function composeMarked(image: MarkImage, marks: readonly Mark[]): Promise<Uint8Array | null> {
  const source = await loadImage(image.dataUrl);
  const crop = activeCrop(marks, image.width, image.height) ?? { x: 0, y: 0, width: image.width, height: image.height };
  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.translate(-crop.x, -crop.y);
  context.drawImage(source, 0, 0, image.width, image.height);
  drawMarks(context, marks, strokeFor(image.width, image.height));
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

export interface ScreenshotEditorProps {
  host: WebPackageHost;
  t: Translate;
  image: MarkImage;
  marks: Mark[];
  onMarksChange: (marks: Mark[]) => void;
}

export function ScreenshotEditor({ host, t, image, marks, onMarksChange }: ScreenshotEditorProps) {
  const { IconButton } = host.ui.components;
  const [tool, setTool] = useState<MarkTool>("arrow");
  const [color, setColor] = useState<string>(MARK_COLORS[0]);
  const [draft, setDraftState] = useState<Mark | null>(null);
  // The mark being drawn, read by pointer-up before React has re-rendered
  // the last move.
  const draftRef = useRef<Mark | null>(null);
  const setDraft = (next: Mark | null) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef<number | null>(null);

  // Fit the whole screenshot in the stage, never upscaled past 1:1 by more
  // than the stage allows; the canvas keeps the screenshot's own pixels.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => {
      const scale = Math.min(stage.clientWidth / image.width, stage.clientHeight / image.height);
      if (!Number.isFinite(scale) || scale <= 0) return;
      setBox({ width: Math.floor(image.width * scale), height: Math.floor(image.height * scale) });
    };
    fit();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    observer?.observe(stage);
    return () => observer?.disconnect();
  }, [image.width, image.height]);

  // Marks, the one being drawn, and outside a crop a veil: what is cut away
  // stays visible enough to adjust, but reads as gone.
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const shown = draft && draft.kind !== "crop" ? [...marks, draft] : marks;
    const stroke = strokeFor(image.width, image.height);
    drawMarks(context, shown, stroke);
    const crop = activeCrop(draft?.kind === "crop" ? [...marks, draft] : marks, image.width, image.height);
    if (crop) {
      context.save();
      context.fillStyle = "rgba(0, 0, 0, 0.55)";
      context.beginPath();
      context.rect(0, 0, image.width, image.height);
      context.rect(crop.x, crop.y, crop.width, crop.height);
      context.fill("evenodd");
      context.restore();
    }
    if (draft?.kind === "crop") {
      const rect = rectOf(draft.from, draft.to);
      context.save();
      context.lineWidth = Math.max(1, stroke / 2);
      context.strokeStyle = "#ffffff";
      context.setLineDash([stroke * 2, stroke * 1.5]);
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
      context.restore();
    }
  }, [marks, draft, image.width, image.height, box]);

  const pointAt = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return clampPoint({
      x: ((event.clientX - rect.left) / rect.width) * image.width,
      y: ((event.clientY - rect.top) / rect.height) * image.height,
    }, image.width, image.height);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current !== null || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    pointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = pointAt(event);
    setDraft(tool === "pen" ? { kind: "pen", color, points: [at] }
      : tool === "crop" ? { kind: "crop", from: at, to: at }
        : { kind: tool, color, from: at, to: at });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current !== event.pointerId) return;
    const current = draftRef.current;
    if (!current) return;
    const at = pointAt(event);
    setDraft(current.kind === "pen" ? { ...current, points: extendPen(current.points, at) } : { ...current, to: at });
  };

  const finish = (event: ReactPointerEvent<HTMLCanvasElement>, keep: boolean) => {
    if (pointerRef.current !== event.pointerId) return;
    pointerRef.current = null;
    const done = draftRef.current;
    if (keep && done && isMeaningful(done)) onMarksChange([...marks, done]);
    setDraft(null);
  };

  const undo = useCallback(() => {
    if (marks.length > 0) onMarksChange(marks.slice(0, -1));
  }, [marks, onMarksChange]);

  // ⌘Z / Ctrl+Z while the editor is open; text fields keep their own undo.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "z" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  return (
    <div className="bug-report-editor">
      <div className="bug-report-editor__bar" role="toolbar" aria-label={t("bugreport.markTitle")}>
        <div className="bug-report-editor__group" role="group" aria-label={t("bugreport.toolsLabel")}>
          {TOOLS.map((entry) => (
            <IconButton
              key={entry.tool}
              icon={TOOL_GLYPHS[entry.tool]}
              label={t(entry.label)}
              title={t(entry.label)}
              pressed={tool === entry.tool}
              onClick={() => setTool(entry.tool)}
            />
          ))}
        </div>
        <span className="bug-report-editor__divider" aria-hidden="true" />
        <div className="bug-report-editor__group" role="group" aria-label={t("bugreport.colorLabel")}>
          {MARK_COLORS.map((value) => (
            <button
              key={value}
              type="button"
              className="bug-report-editor__swatch"
              style={{ "--bug-report-swatch": value } as Record<string, string>}
              aria-label={t(COLOR_KEYS[value])}
              title={t(COLOR_KEYS[value])}
              aria-pressed={color === value}
              disabled={tool === "crop"}
              onClick={() => setColor(value)}
            />
          ))}
        </div>
        <span className="bug-report-editor__divider" aria-hidden="true" />
        <IconButton icon={UndoGlyph} label={t("bugreport.undo")} title={t("bugreport.undo")} disabled={marks.length === 0} onClick={undo} />
      </div>
      <div className="bug-report-editor__stage" ref={stageRef}>
        {box && (
          <div className="bug-report-editor__frame" style={{ width: box.width, height: box.height }}>
            <img className="bug-report-editor__image" src={image.dataUrl} alt={t("bugreport.screenshotAlt")} draggable={false} />
            <canvas
              ref={canvasRef}
              className="bug-report-editor__canvas"
              data-tool={tool}
              width={image.width}
              height={image.height}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={(event) => finish(event, true)}
              onPointerCancel={(event) => finish(event, false)}
              onLostPointerCapture={(event) => finish(event, true)}
            />
          </div>
        )}
      </div>
      <p className="bug-report-editor__hint">{t("bugreport.markHint")}</p>
    </div>
  );
}
