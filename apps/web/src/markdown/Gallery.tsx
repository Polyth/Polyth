// Image lightbox for Markdown documents (WP4). Thumbnails render inline; a
// click opens the document-wide gallery with keyboard prev/next.
import { useState } from "react";
import Dialog from "../components/a11y/Dialog.tsx";

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
    <Dialog title={`Image ${idx + 1} of ${images.length}`} size="full" className="gallery-dialog" onClose={onClose}>
      <div className="dialog-head">
        <span className="dialog-title">{img.alt || img.src}</span>
        <span className="header-spacer" />
        <span className="muted">{idx + 1} / {images.length}</span>
        <button className="small-btn" onClick={onClose}>Close</button>
      </div>
      <div
        className="gallery-stage"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
          else if (e.key === "ArrowRight") { e.preventDefault(); next(); }
        }}
      >
        {images.length > 1 && <button className="gallery-nav prev" aria-label="Previous image" onClick={prev}>‹</button>}
        <img className="gallery-img" src={img.src} alt={img.alt} />
        {images.length > 1 && <button className="gallery-nav next" aria-label="Next image" onClick={next}>›</button>}
      </div>
    </Dialog>
  );
}
