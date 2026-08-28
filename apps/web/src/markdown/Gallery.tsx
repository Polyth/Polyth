// Image lightbox for Markdown documents (WP4). Thumbnails render inline; a
// click opens the document-wide gallery with keyboard prev/next.
import { useState } from "react";
import { tr } from "../i18n/index.ts";
import { Dialog } from "../components/ui/index.ts";

export interface GalleryImage { src: string; alt: string }

export default function GalleryLightbox({ images, start, onClose }: {
  images: GalleryImage[];
  start: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(Math.min(Math.max(start, 0), images.length - 1));
  const img = images[idx];
  if (!img) return null;
  const prev = () => setIdx((i) => (i - 1 + images.length) % images.length);
  const next = () => setIdx((i) => (i + 1) % images.length);
  return (
    <Dialog title={img.alt || tr("markdown.gallery.imageValueOfValue", { value: idx + 1, length: images.length })} size="full" className="gallery-dialog" onClose={onClose}>
      <div className="gallery-count muted">{idx + 1} / {images.length}</div>
      <div
        className="gallery-stage"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
          else if (e.key === "ArrowRight") { e.preventDefault(); next(); }
        }}
      >
        {images.length > 1 && <button className="gallery-nav prev" aria-label={tr("markdown.gallery.previousImage")} onClick={prev}>‹</button>}
        <img className="gallery-img" src={img.src} alt={img.alt} />
        {images.length > 1 && <button className="gallery-nav next" aria-label={tr("markdown.gallery.nextImage")} onClick={next}>›</button>}
      </div>
    </Dialog>
  );
}
