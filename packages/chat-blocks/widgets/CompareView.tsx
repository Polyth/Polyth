// Side-by-side comparison: compared objects are columns, features are rows,
// the winning value of a row marked ↑/↓ is highlighted. With pick= a column
// header selects that object for the block's buttons.
import type { MarkdownFenceContext } from "@polyth/web-sdk";
import { bestIndex, type ChatBlockDoc } from "../src/parse.ts";
import { Icon, ZoomInIcon } from "../../../apps/web/src/components/ui/index.ts";
import { BlockHead, Mark, Media, imageUrl, useBlockGallery } from "./shared.tsx";
import { fill, type ChatBlockStrings } from "./strings.ts";

export default function CompareView({ doc, t, context, selected, toggle, locked }: {
  doc: ChatBlockDoc;
  t: ChatBlockStrings;
  context: MarkdownFenceContext;
  selected: ReadonlySet<number>;
  toggle(index: number): void;
  locked: boolean;
}) {
  const withImages = doc.columnImages.some(Boolean);
  const picking = doc.pick !== "none";
  const images = doc.columns.map((name, col) => ({ src: imageUrl(doc.columnImages[col], context), title: name }));
  const gallery = useBlockGallery(images);
  return (
    <>
      <BlockHead title={doc.title} count={doc.columns.length > 1 ? String(doc.columns.length) : undefined} />
      <div className="chat-block-table-wrap chat-block-compare-wrap">
        <table className="chat-block-compare">
          <thead>
            <tr>
              <td className="chat-block-compare-corner" />
              {doc.columns.map((name, col) => {
                const isSelected = selected.has(col);
                const src = images[col]?.src ?? null;
                const head = (
                  <>
                    {withImages && <Media src={src} title={name} className="chat-block-compare-media" />}
                    <span className="chat-block-compare-name">{name}</span>
                    {picking && <Mark />}
                  </>
                );
                return (
                  <th key={col} scope="col" className={isSelected ? "is-selected" : undefined}>
                    {picking ? (
                      <button
                        type="button"
                        className="chat-block-compare-head"
                        role={doc.pick === "one" ? "radio" : "checkbox"}
                        aria-checked={isSelected}
                        aria-label={fill(t.select, { title: name })}
                        disabled={locked}
                        onClick={() => toggle(col)}
                      >
                        {head}
                      </button>
                    ) : <div className="chat-block-compare-head">{head}</div>}
                    {src && (
                      <button
                        type="button"
                        className="chat-block-zoom is-corner"
                        aria-label={fill(t.view, { title: name })}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          gallery.open(src);
                        }}
                      >
                        <Icon icon={ZoomInIcon} size="sm" />
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {doc.items.map((item) => {
              const best = bestIndex(item);
              return (
                <tr key={item.index}>
                  <th scope="row">{item.title}</th>
                  {doc.columns.map((_, col) => (
                    <td key={col} className={[best === col ? "is-best" : "", selected.has(col) ? "is-selected" : ""].filter(Boolean).join(" ") || undefined}>
                      {item.cells[col] || "—"}
                      {best === col && <span className="chat-block-best" aria-label={t.best}>{item.best === "min" ? "↓" : "↑"}</span>}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {gallery.gallery}
    </>
  );
}
