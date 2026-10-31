// An image gallery. A tile opens the host's full-screen viewer over every
// image in the block (arrows, swipe, thumbnails); with pick= a tile selects
// and a zoom control opens the viewer instead.
import { useState } from "react";
import type { MarkdownFenceContext } from "@polyth/web-sdk";
import type { ChatBlockDoc } from "../src/parse.ts";
import { Button, ExternalLinkIcon, Icon, ZoomInIcon } from "../../../apps/web/src/components/ui/index.ts";
import ImageLightbox from "../../../apps/web/src/markdown/ImageLightbox.tsx";
import { BlockHead, Mark, Media, imageUrl, mediaRatio, safeLink, usePaging } from "./shared.tsx";
import { fill, type ChatBlockStrings } from "./strings.ts";

const MEDIA_PREVIEW = 12;

export default function MediaView({ doc, t, context, selected, toggle, locked, streaming }: {
  doc: ChatBlockDoc;
  t: ChatBlockStrings;
  context: MarkdownFenceContext;
  selected: ReadonlySet<number>;
  toggle(index: number): void;
  locked: boolean;
  streaming: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const paging = usePaging(doc.items.length, MEDIA_PREVIEW, 24);
  const tiles = doc.items.map((item) => ({ item, src: imageUrl(item.image, context) }));
  const viewable = tiles.filter((tile) => tile.src !== null);
  const ratio = mediaRatio(doc.options.ratio);
  const openAt = (index: number) => {
    const at = viewable.findIndex((tile) => tile.item.index === index);
    if (at >= 0) setOpen(at);
  };
  return (
    <>
      <BlockHead title={doc.title} count={doc.items.length > 1 ? String(doc.items.length) : undefined} />
      <ul className="chat-block-gallery" style={ratio ? { ["--chat-block-media-ratio" as string]: ratio } : undefined}>
        {tiles.slice(0, paging.visible).map(({ item, src }) => {
          const href = safeLink(item.link);
          const isSelected = selected.has(item.index);
          const name = item.title || fill(t.imageN, { n: item.index + 1 });
          return (
            <li key={item.index} className={`chat-block-tile${isSelected ? " is-selected" : ""}${streaming ? " chat-block-enter" : ""}`}>
              <Media src={src} title={item.title || "·"} />
              {item.title && <span className="chat-block-tile-caption">{item.title}</span>}
              {doc.pick !== "none" ? (
                <>
                  <button
                    type="button"
                    className="chat-block-hit"
                    role={doc.pick === "one" ? "radio" : "checkbox"}
                    aria-checked={isSelected}
                    aria-label={fill(t.select, { title: name })}
                    disabled={locked}
                    onClick={() => toggle(item.index)}
                  />
                  <Mark />
                  {src && (
                    <button type="button" className="chat-block-open" aria-label={fill(t.view, { title: name })} onClick={() => openAt(item.index)}>
                      <Icon icon={ZoomInIcon} size="sm" />
                    </button>
                  )}
                </>
              ) : (
                <button type="button" className="chat-block-hit" aria-label={fill(t.view, { title: name })} disabled={!src} onClick={() => openAt(item.index)} />
              )}
              {href && doc.pick === "none" && (
                <a className="chat-block-open" href={href} target="_blank" rel="noopener noreferrer" aria-label={fill(t.open, { title: name })}>
                  <Icon icon={ExternalLinkIcon} size="sm" />
                </a>
              )}
            </li>
          );
        })}
        {doc.pending && <li className="chat-block-tile chat-block-pending" aria-hidden="true" />}
      </ul>
      {paging.remaining > 0 && (
        <div className="chat-block-more is-bare">
          <Button size="sm" variant="ghost" onClick={paging.more}>{fill(t.showMore, { count: Math.min(24, paging.remaining) })}</Button>
        </div>
      )}
      {open !== null && viewable.length > 0 && (
        <ImageLightbox
          images={viewable.map((tile) => ({ src: tile.src!, alt: tile.item.title }))}
          start={open}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
