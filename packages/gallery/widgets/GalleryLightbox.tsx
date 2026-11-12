// The gallery's viewer is the host media viewer (host.ui.components.MediaViewer):
// paging, swipe, pinch/wheel/double-tap zoom, pull to dismiss, the thumbnail
// strip and the glass chrome all come from the host. The package adds only
// what is its own: the annotation layer drawn over the image, the notes
// panel, and the annotate / include-in-send controls.
import { useMemo, type ChangeEvent } from "react";
import type { WebMediaItem, WebPackageHost } from "@polyth/web-sdk";
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
  host: WebPackageHost;
  t: GalleryTranslate;
}

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
  host,
  t,
}: GalleryLightboxProps) {
  const items = useMemo<WebMediaItem[]>(
    () => images.map((image) => ({ id: image.path, name: image.name, url: rawUrl(image.path) })),
    [images, rawUrl],
  );
  const image = images[index];
  const { Button, IconButton, Textarea, MediaViewer } = host.ui.components;
  const icons = host.ui.icons;
  if (!image || !MediaViewer) return null;

  const tools: Array<{ id: AnnotationTool; label: string }> = [
    { id: "off", label: t("gallery.toolOff") },
    { id: "point", label: t("gallery.toolPoint") },
    { id: "zone", label: t("gallery.toolZone") },
  ];

  const notes = (
    <div className="gallery-notes">
      <header className="gallery-notes-head">
        <h3>{t("gallery.annotations")}</h3>
        <span>{t("gallery.comments", { count: annotations.length })}</span>
      </header>
      {annotations.length === 0
        ? <p className="gallery-notes-empty">{tool === "off" ? t("gallery.noAnnotations") : t("gallery.annotateHint")}</p>
        : (
          <ul className="gallery-notes-list">
            {annotations.map((annotation) => (
              <li
                key={annotation.id}
                className={`gallery-note${annotation.id === activeAnnotationId ? " is-active" : ""}`}
                onPointerEnter={() => onSelectAnnotation(annotation.id)}
              >
                <div className="gallery-note-head">
                  <Button size="sm" variant="quiet" className="gallery-note-goto" onClick={() => onSelectAnnotation(annotation.id)}>
                    {describeAnnotation(annotation)}
                  </Button>
                  <IconButton icon={icons.trash} label={t("gallery.deleteNote")} size="sm" variant="quiet" onClick={() => onDeleteAnnotation(annotation.id)} />
                </div>
                <Textarea
                  value={annotation.comment}
                  placeholder={t("gallery.commentPlaceholder")}
                  aria-label={describeAnnotation(annotation)}
                  autoGrow
                  minRows={2}
                  maxRows={6}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onUpdateComment(annotation.id, event.target.value)}
                />
              </li>
            ))}
          </ul>
        )}
    </div>
  );

  const actions = (
    <>
      <div role="group" aria-label={t("gallery.annotate")}>
        {tools.map((entry) => (
          <Button key={entry.id} size="sm" variant={tool === entry.id ? "primary" : "quiet"} aria-pressed={tool === entry.id} onClick={() => onTool(entry.id)}>
            {entry.label}
          </Button>
        ))}
      </div>
      <div>
        <Button size="sm" variant={selected ? "primary" : "quiet"} iconStart={selected ? icons.check : icons.select} aria-pressed={selected} onClick={() => onToggleSelected(image.path)}>
          {t("gallery.includeInSend")}
        </Button>
      </div>
    </>
  );

  return (
    <MediaViewer
      items={items}
      index={index}
      onIndexChange={onIndex}
      onClose={onClose}
      className="gallery-viewer"
      gesturesDisabled={tool !== "off"}
      renderOverlay={() => (
        <AnnotationLayer
          annotations={annotations}
          activeId={activeAnnotationId}
          tool={tool}
          onAdd={onAddAnnotation}
          onSelect={onSelectAnnotation}
        />
      )}
      aside={notes}
      asideLabel={t("gallery.annotations")}
      actions={actions}
    />
  );
}
