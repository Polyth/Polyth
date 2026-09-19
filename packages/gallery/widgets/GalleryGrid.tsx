import type { GalleryImage } from "../src/shared.ts";
import type { AnnotationsByImage } from "./galleryState.ts";
import type { GalleryTranslate } from "./galleryI18n.ts";

interface GalleryGridProps {
  images: readonly GalleryImage[];
  rawUrl: (path: string) => string;
  annotationsByImage: AnnotationsByImage;
  selectedPaths: ReadonlySet<string>;
  onOpen: (path: string) => void;
  onToggleSelect: (path: string) => void;
  t: GalleryTranslate;
}

export function GalleryGrid({
  images,
  rawUrl,
  annotationsByImage,
  selectedPaths,
  onOpen,
  onToggleSelect,
  t,
}: GalleryGridProps) {
  return (
    <div className="gallery-grid" role="list">
      {images.map((image, index) => {
        const notes = annotationsByImage[image.path]?.length ?? 0;
        const selected = selectedPaths.has(image.path);
        return (
          <div
            key={image.path}
            role="listitem"
            className={`gallery-tile${selected ? " is-selected" : ""}`}
            style={{ animationDelay: `${Math.min(index, 24) * 22}ms` }}
          >
            <button
              type="button"
              className="gallery-tile-open"
              onClick={() => onOpen(image.path)}
              title={image.path}
            >
              <img
                src={rawUrl(image.path)}
                alt={t("gallery.imageAlt", { name: image.name })}
                loading="lazy"
                decoding="async"
                draggable={false}
              />
              {notes > 0 && <span className="gallery-tile-badge">{notes}</span>}
            </button>
            <label className="gallery-tile-select" title={t("gallery.select")}>
              <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggleSelect(image.path)}
              />
              <span className="gallery-tile-select-box" aria-hidden="true" />
            </label>
            <span className="gallery-tile-name">{image.name}</span>
          </div>
        );
      })}
    </div>
  );
}
