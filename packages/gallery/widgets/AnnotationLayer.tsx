import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  clamp01,
  normalizeDragRect,
  GALLERY_MIN_RECT,
  type GalleryAnnotation,
} from "../src/shared.ts";
import { newAnnotationId } from "./galleryState.ts";

export type AnnotationTool = "off" | "point" | "zone";

interface AnnotationLayerProps {
  annotations: readonly GalleryAnnotation[];
  activeId: string | null;
  tool: AnnotationTool;
  onAdd: (annotation: GalleryAnnotation) => void;
  onSelect: (id: string | null) => void;
}

const rectStyle = (x: number, y: number, w: number, h: number): CSSProperties => ({
  left: `${x * 100}%`,
  top: `${y * 100}%`,
  width: `${w * 100}%`,
  height: `${h * 100}%`,
});

const pointStyle = (x: number, y: number): CSSProperties => ({
  left: `${x * 100}%`,
  top: `${y * 100}%`,
});

export function AnnotationLayer({ annotations, activeId, tool, onAdd, onSelect }: AnnotationLayerProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const interactive = tool !== "off";

  const pointFromEvent = (event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const element = surfaceRef.current;
    if (!element) return { x: 0, y: 0 };
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
    return {
      x: clamp01((event.clientX - box.left) / box.width),
      y: clamp01((event.clientY - box.top) / box.height),
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const point = pointFromEvent(event);
    if (tool === "point") {
      onAdd({ id: newAnnotationId(), kind: "point", x: point.x, y: point.y, w: 0, h: 0, comment: "" });
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragStart.current = point;
    setDraft({ x: point.x, y: point.y, w: 0, h: 0 });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || tool !== "zone" || !dragStart.current) return;
    const point = pointFromEvent(event);
    setDraft(normalizeDragRect({
      x0: dragStart.current.x,
      y0: dragStart.current.y,
      x1: point.x,
      y1: point.y,
    }));
  };

  const finishZone = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool !== "zone" || !dragStart.current) return;
    const point = pointFromEvent(event);
    const rect = normalizeDragRect({
      x0: dragStart.current.x,
      y0: dragStart.current.y,
      x1: point.x,
      y1: point.y,
    });
    dragStart.current = null;
    setDraft(null);
    if (rect.w >= GALLERY_MIN_RECT && rect.h >= GALLERY_MIN_RECT) {
      onAdd({ id: newAnnotationId(), kind: "rect", ...rect, comment: "" });
    }
  };

  return (
    <div
      ref={surfaceRef}
      className={`gallery-annotation-layer gallery-tool-${tool}${interactive ? " is-interactive" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishZone}
      onPointerCancel={() => { dragStart.current = null; setDraft(null); }}
    >
      {annotations.map((annotation) => (
        <button
          key={annotation.id}
          type="button"
          className={`gallery-annotation${annotation.kind === "rect" ? " is-rect" : " is-point"}${annotation.id === activeId ? " is-active" : ""}`}
          style={annotation.kind === "rect"
            ? rectStyle(annotation.x, annotation.y, annotation.w, annotation.h)
            : pointStyle(annotation.x, annotation.y)}
          onPointerDown={(event) => {
            event.stopPropagation();
            onSelect(annotation.id);
          }}
          aria-label={annotation.comment || annotation.kind}
        >
          <span className="gallery-annotation-dot" aria-hidden="true" />
        </button>
      ))}
      {draft && <div className="gallery-annotation-draft" style={rectStyle(draft.x, draft.y, draft.w, draft.h)} />}
    </div>
  );
}
