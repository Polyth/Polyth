// Image lightbox for Markdown documents. Thumbnails render inline; a
// click opens the shared full-screen attachment viewer over every image in
// the document.
import { tr } from "../i18n/index.ts";
import AttachmentPreview from "../components/AttachmentPreview.tsx";

export interface MarkdownImage { src: string; alt: string }

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
  return <AttachmentPreview attachments={attachments} start={start} onClose={onClose} />;
}
