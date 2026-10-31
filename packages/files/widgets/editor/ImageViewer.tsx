// Image preview for binary image files: fit-to-pane or actual pixels, the
// natural dimensions, and a checkerboard so transparency reads as such.
import { useState } from "react";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import { Tabs } from "../../../../apps/web/src/components/ui/index.ts";

type ImageZoom = "fit" | "actual";

export default function ImageViewer({ src, alt }: { src: string; alt: string }) {
  const [zoom, setZoom] = useState<ImageZoom>("fit");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return (
    <div className="editor-body editor-image" data-zoom={zoom}>
      <div className="editor-image-stage">
        <img
          className="editor-image-item"
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onClick={() => setZoom((current) => current === "fit" ? "actual" : "fit")}
        />
      </div>
      <div className="editor-image-bar">
        <Tabs
          size="sm"
          label={tr("editor.filepane.imageZoom")}
          value={zoom}
          tabs={[
            { id: "fit", label: tr("editor.filepane.imageFit") },
            { id: "actual", label: "100%" },
          ]}
          onChange={(value) => setZoom(value as ImageZoom)}
        />
        {size && <span className="editor-image-size">{`${size.width} × ${size.height}`}</span>}
      </div>
    </div>
  );
}
