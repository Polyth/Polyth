// Image lightbox for Markdown documents. Thumbnails render inline; a
// click opens the shared full-screen attachment viewer over every image in
// the document.
import { tr } from "../i18n/index.ts";
import AttachmentPreview from "../components/AttachmentPreview.tsx";

/** `caption` is text the reader already saw beside the picture (a tile's
 *  title); the viewer repeats it in full under the image. */
export interface MarkdownImage { src: string; alt: string; caption?: string }

export default function ImageLightbox({ images, start, onClose }: {
  images: MarkdownImage[];
  start: number;
  onClose: () => void;
}) {
  const attachments = images.map((img, i) => ({
    id: `${i}:${img.src}`,
    name: img.alt || tr("markdown.gallery.imageValueOfValue", { value: i + 1, length: images.length }),
    mime: "image/*",
    size: 0,
    kind: "image" as const,
    url: img.src,
  }));
  const hasCaptions = images.some((img) => img.caption?.trim());
  return (
    <AttachmentPreview
      attachments={attachments}
      start={start}
      onClose={onClose}
      caption={hasCaptions ? (_attachment, i) => images[i]?.caption?.trim() || null : undefined}
    />
  );
}
