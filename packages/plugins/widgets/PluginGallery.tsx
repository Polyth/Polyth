import { useCallback, useEffect, useState } from "react";
import type { PackageScreenshotDto } from "@polyth/contracts";
import { Button, Dialog, Icon } from "../../../apps/web/src/components/ui/index.ts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExpandIcon,
  PackageIcon,
} from "../../../apps/web/src/components/ui/icons.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

/** Public packages declare `display.icon` as a glyph (an emoji or a single
 *  character) or as a name. Only an actual glyph is rendered — a word would
 *  print as text, so a named icon falls back to the shared package mark. */
export function packageGlyph(icon: string | undefined): string | null {
  if (!icon) return null;
  const glyph = icon.trim();
  if (!glyph || glyph.length > 4) return null;
  if (/^[\p{L}\p{N} _-]+$/u.test(glyph)) return null;
  return [...glyph].length <= 2 ? glyph : null;
}

/** A package's identity mark for a list tile or the detail header: its own
 *  glyph when it declares one, else the shared package mark. */
export function PluginMark({ plugin, size = "md" }: { plugin: { icon?: string }; size?: "md" | "lg" }) {
  const glyph = packageGlyph(plugin.icon);
  if (glyph) return <span className="plugin-mark-glyph">{glyph}</span>;
  return <Icon icon={PackageIcon} size={size === "lg" ? "lg" : "md"} />;
}

/** Package gallery. Screenshots are the first thing a reader judges, so they
 *  get one framed 16:10 stage (cover-cropped so mixed captures still agree on
 *  a silhouette), a thumbnail rail, and an un-cropped full-size viewer. */
export function PluginGallery({ screenshots, name }: { screenshots: readonly PackageScreenshotDto[]; name: string }) {
  const [index, setIndex] = useState(0);
  const [viewer, setViewer] = useState(false);
  const active = screenshots[Math.min(index, screenshots.length - 1)];
  const step = useCallback((delta: number) => {
    setIndex((current) => (current + delta + screenshots.length) % screenshots.length);
  }, [screenshots.length]);

  useEffect(() => {
    if (!viewer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
      if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, viewer]);

  if (screenshots.length === 0 || !active) return null;
  const caption = active.caption ?? active.alt;

  return (
    <figure className="plugin-gallery">
      <button
        type="button"
        className="plugin-shot"
        onClick={() => setViewer(true)}
        aria-label={tr("packages.plugins.openScreenshot", { name })}
      >
        <img src={active.url} alt={active.alt ?? active.caption ?? name} loading="lazy" decoding="async" />
        <span className="plugin-shot-expand" aria-hidden="true"><Icon icon={ExpandIcon} size="sm" /></span>
      </button>
      {(caption || screenshots.length > 1) && (
        <figcaption className="plugin-shot-foot">
          {screenshots.length > 1 && (
            <span className="plugin-shot-rail" role="tablist" aria-label={tr("packages.plugins.screenshots")}>
              {screenshots.map((shot, position) => (
                <button
                  key={shot.url}
                  type="button"
                  role="tab"
                  aria-selected={position === index}
                  aria-label={shot.caption ?? shot.alt ?? `${position + 1} / ${screenshots.length}`}
                  className={`plugin-shot-thumb${position === index ? " on" : ""}`}
                  onClick={() => setIndex(position)}
                >
                  <img src={shot.url} alt="" loading="lazy" decoding="async" />
                </button>
              ))}
            </span>
          )}
          {caption && <span className="plugin-shot-caption">{caption}</span>}
        </figcaption>
      )}
      {viewer && (
        <Dialog
          title={caption ?? tr("packages.plugins.screenshots")}
          size="full"
          className="plugin-shot-dialog"
          onClose={() => setViewer(false)}
          {...(screenshots.length > 1 ? {
            footer: (
              <>
                <span className="plugin-shot-count">{index + 1} / {screenshots.length}</span>
                <Button size="sm" variant="quiet" iconStart={ChevronLeftIcon} onClick={() => step(-1)}>
                  {tr("packages.plugins.previousScreenshot")}
                </Button>
                <Button size="sm" variant="quiet" iconEnd={ChevronRightIcon} onClick={() => step(1)}>
                  {tr("packages.plugins.nextScreenshot")}
                </Button>
              </>
            ),
          } : {})}
        >
          <div className="plugin-shot-stage">
            <img src={active.url} alt={active.alt ?? active.caption ?? name} />
          </div>
        </Dialog>
      )}
    </figure>
  );
}
