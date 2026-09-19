import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { describeAnnotation, type GalleryAnnotation, type GalleryImage } from "../src/shared.ts";
import { AnnotationLayer, type AnnotationTool } from "./AnnotationLayer.tsx";
import type { GalleryTranslate } from "./galleryI18n.ts";

interface GalleryLightboxProps {
  images: readonly GalleryImage[];
  index: number;
  onIndex: (index: number) => void;
  rawUrl: (path: string) => string;
  annotations: readonly GalleryAnnotation[];
  activeAnnotationId: string | null;
  onSelectAnnotation: (id: string | null) => void;
  tool: AnnotationTool;
  onTool: (tool: AnnotationTool) => void;
  selected: boolean;
  onToggleSelected: (path: string) => void;
  onAddAnnotation: (annotation: GalleryAnnotation) => void;
  onUpdateComment: (id: string, comment: string) => void;
  onDeleteAnnotation: (id: string) => void;
  onClose: () => void;
  t: GalleryTranslate;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function GalleryLightbox({
  images,
  index,
  onIndex,
  rawUrl,
  annotations,
  activeAnnotationId,
  onSelectAnnotation,
  tool,
  onTool,
  selected,
  onToggleSelected,
  onAddAnnotation,
  onUpdateComment,
  onDeleteAnnotation,
  onClose,
  t,
}: GalleryLightboxProps) {
  const image = images[index];
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });

  // The annotation layer must cover exactly the rendered image, so the frame
  // is sized from the image's natural box and the actual stage box instead of
  // relying on object-fit letterboxing (which would offset every coordinate).
  useEffect(() => {
    setNatural(null);
    // A cached image can finish before React attaches onLoad; read it back.
    const element = imgRef.current;
    if (element?.complete && element.naturalWidth > 0) {
      setNatural({ w: element.naturalWidth, h: element.naturalHeight });
    }
  }, [image?.path]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const box = stage.getBoundingClientRect();
      setStageSize({ w: box.width, h: box.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const fit = useMemo(() => {
    if (!natural || stageSize.w <= 0 || stageSize.h <= 0) return null;
    const scale = Math.min(stageSize.w / natural.w, stageSize.h / natural.h, 1);
    return { w: Math.max(1, Math.round(natural.w * scale)), h: Math.max(1, Math.round(natural.h * scale)) };
  }, [natural, stageSize]);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    resetView();
  }, [image?.path, resetView]);

  // React attaches wheel listeners passively, so zoom must be bound natively
  // to be able to preventDefault the page scroll behind the lightbox.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (tool !== "off") return;
      event.preventDefault();
      setZoom((value) => clamp(value + (event.deltaY < 0 ? 0.3 : -0.3), MIN_ZOOM, MAX_ZOOM));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [tool]);

  const go = useCallback((delta: number) => {
    if (images.length === 0) return;
    const next = (index + delta + images.length) % images.length;
    onIndex(next);
  }, [images.length, index, onIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight") go(1);
      else if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "+" || event.key === "=") setZoom((value) => clamp(value + 0.5, MIN_ZOOM, MAX_ZOOM));
      else if (event.key === "-") setZoom((value) => clamp(value - 0.5, MIN_ZOOM, MAX_ZOOM));
      else if (event.key === "0") resetView();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go, onClose, resetView]);

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool !== "off" || zoom <= MIN_ZOOM) return;
    // Let the overlay buttons (navigation, close) keep their own clicks.
    if ((event.target as HTMLElement).closest("button")) return;
    const stage = stageRef.current;
    if (!stage) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    const stage = stageRef.current;
    if (!current || !stage || event.pointerId !== current.pointerId) return;
    const box = stage.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const limit = (zoom - 1) * 50;
    setPan({
      x: clamp(current.panX + ((event.clientX - current.startX) / box.width) * 100, -limit, limit),
      y: clamp(current.panY + ((event.clientY - current.startY) / box.height) * 100, -limit, limit),
    });
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current && event.pointerId === drag.current.pointerId) drag.current = null;
  };

  if (!image) return null;

  const tools: Array<{ id: AnnotationTool; label: string }> = [
    { id: "off", label: t("gallery.toolOff") },
    { id: "point", label: t("gallery.toolPoint") },
    { id: "zone", label: t("gallery.toolZone") },
  ];

  return (
    <div className="gallery-lightbox" role="dialog" aria-modal="true" aria-label={t("gallery.title")}>
      <button type="button" className="gallery-lightbox-backdrop" aria-label={t("gallery.close")} onClick={onClose} />
      <div className="gallery-lightbox-topbar">
        <span className="gallery-lightbox-counter">{index + 1} / {images.length}</span>
        <span className="gallery-lightbox-name" title={image.path}>{image.name}</span>
        <button
          type="button"
          className={`gallery-tool-button gallery-include-button${selected ? " is-active" : ""}`}
          onClick={() => onToggleSelected(image.path)}
          aria-pressed={selected}
        >
          {t("gallery.includeInSend")}
        </button>
        <div className="gallery-tool-switch" role="group" aria-label={t("gallery.annotate")}>
          {tools.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`gallery-tool-button${tool === entry.id ? " is-active" : ""}`}
              onClick={() => onTool(entry.id)}
              aria-pressed={tool === entry.id}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button type="button" className="gallery-icon-button" onClick={() => setZoom((v) => clamp(v - 0.5, MIN_ZOOM, MAX_ZOOM))} aria-label={t("gallery.zoomOut")}>−</button>
        <button type="button" className="gallery-icon-button" onClick={() => setZoom((v) => clamp(v + 0.5, MIN_ZOOM, MAX_ZOOM))} aria-label={t("gallery.zoomIn")}>+</button>
        <button type="button" className="gallery-icon-button" onClick={resetView} aria-label={t("gallery.zoomReset")}>⤢</button>
        <button type="button" className="gallery-icon-button" onClick={onClose} aria-label={t("gallery.close")}>✕</button>
      </div>

      <div className="gallery-lightbox-body">
        <div
          ref={stageRef}
          className={`gallery-lightbox-stage gallery-tool-${tool}${zoom > MIN_ZOOM ? " is-pannable" : ""}`}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onDoubleClick={() => { if (tool === "off") setZoom((value) => (value > MIN_ZOOM ? 1 : 2)); }}
        >
          <button type="button" className="gallery-nav gallery-nav-prev" onClick={() => go(-1)} aria-label={t("gallery.previous")}>‹</button>
          <div
            className="gallery-lightbox-frame"
            style={{
              ...(fit ? { width: `${fit.w}px`, height: `${fit.h}px` } : {}),
              transform: `translate(${pan.x}%, ${pan.y}%) scale(${zoom})`,
            }}
          >
            <img
              ref={imgRef}
              src={rawUrl(image.path)}
              alt={t("gallery.imageAlt", { name: image.name })}
              draggable={false}
              onLoad={(event) => setNatural({
                w: event.currentTarget.naturalWidth,
                h: event.currentTarget.naturalHeight,
              })}
            />
            <AnnotationLayer
              annotations={annotations}
              activeId={activeAnnotationId}
              tool={tool}
              onAdd={onAddAnnotation}
              onSelect={onSelectAnnotation}
            />
          </div>
          <button type="button" className="gallery-nav gallery-nav-next" onClick={() => go(1)} aria-label={t("gallery.next")}>›</button>
          {tool !== "off" && <p className="gallery-annotate-hint">{t("gallery.annotateHint")}</p>}
        </div>

        <aside className="gallery-notes">
          <header className="gallery-notes-head">
            <h4>{t("gallery.annotations")}</h4>
            <span>{t("gallery.comments", { count: annotations.length })}</span>
          </header>
          {annotations.length === 0
            ? <p className="gallery-notes-empty">{t("gallery.noAnnotations")}</p>
            : (
              <ul className="gallery-notes-list">
                {annotations.map((annotation) => (
                  <li
                    key={annotation.id}
                    className={`gallery-note${annotation.id === activeAnnotationId ? " is-active" : ""}`}
                    onPointerEnter={() => onSelectAnnotation(annotation.id)}
                  >
                    <div className="gallery-note-head">
                      <button type="button" className="gallery-note-goto" onClick={() => onSelectAnnotation(annotation.id)}>
                        {describeAnnotation(annotation)}
                      </button>
                      <button
                        type="button"
                        className="gallery-note-delete"
                        onClick={() => onDeleteAnnotation(annotation.id)}
                        aria-label={t("gallery.deleteNote")}
                      >✕</button>
                    </div>
                    <textarea
                      value={annotation.comment}
                      placeholder={t("gallery.commentPlaceholder")}
                      onChange={(event) => onUpdateComment(annotation.id, event.target.value)}
                      rows={2}
                    />
                  </li>
                ))}
              </ul>
            )}
        </aside>
      </div>

      <div className="gallery-filmstrip" role="group" aria-label={t("gallery.count", { count: images.length })}>
        {images.map((entry, entryIndex) => (
          <button
            key={entry.path}
            type="button"
            className={`gallery-film${entryIndex === index ? " is-active" : ""}`}
            onClick={() => onIndex(entryIndex)}
            title={entry.name}
          >
            <img src={rawUrl(entry.path)} alt="" loading="lazy" decoding="async" draggable={false} />
          </button>
        ))}
      </div>
    </div>
  );
}
