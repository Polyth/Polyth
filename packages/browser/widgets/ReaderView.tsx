// Reader view: the server's redacted page-text observation as plain text over
// the browser stage. The viewer owns fetching; this renders the states. It is
// text only by design (no images or page markup ever reach it); tab-separated
// lines from a page table are laid out as a simple grid so columns stay legible.
import { useEffect, useRef, type KeyboardEvent } from "react";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { BackIcon, Button, DocsIcon, EmptyState, Icon, Notice, Spinner } from "../../../apps/web/src/components/ui/index.ts";

export interface ReaderState {
  status: "loading" | "ready" | "error";
  title: string;
  paragraphs: string[];
}

export type ReaderBlock =
  | { kind: "text"; text: string }
  | { kind: "break" }
  | { kind: "table"; rows: string[][] };

/** Group reader lines: "" → break, consecutive tab-separated lines → one table. */
export function readerBlocks(paragraphs: readonly string[]): ReaderBlock[] {
  const blocks: ReaderBlock[] = [];
  for (const line of paragraphs) {
    if (!line) { blocks.push({ kind: "break" }); continue; }
    if (line.includes("\t")) {
      const cells = line.split("\t");
      const last = blocks[blocks.length - 1];
      if (last?.kind === "table") last.rows.push(cells);
      else blocks.push({ kind: "table", rows: [cells] });
      continue;
    }
    blocks.push({ kind: "text", text: line });
  }
  return blocks;
}

export default function ReaderView({ reader, fallbackTitle, onExit, onRetry }: {
  reader: ReaderState;
  /** Shown while the page title is unknown (compact page identity). */
  fallbackTitle: string;
  onExit: () => void;
  onRetry?: () => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Opening the reader moves focus into it, so keyboard and screen-reader
  // users land on the text rather than the hidden page behind it.
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, []);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onExit();
  };
  return (
    <section
      className="browser-reader"
      aria-label={tr("browser.reader.label")}
      aria-busy={reader.status === "loading"}
      onKeyDown={onKeyDown}
    >
      <div className="browser-reader-head">
        <h2 ref={titleRef} className="browser-reader-title" tabIndex={-1} title={reader.title || fallbackTitle}>
          {reader.title || fallbackTitle}
        </h2>
        {reader.status === "loading" && reader.paragraphs.length > 0 && <Spinner size="sm" />}
        <Button size="sm" iconStart={BackIcon} className="browser-reader-exit" onClick={onExit}>{tr("browser.reader.exit")}</Button>
      </div>
      <div className="browser-reader-scroll">
        {reader.status === "error" ? (
          <div className="browser-reader-column">
            <Notice
              tone="error"
              role="alert"
              actions={onRetry ? <Button size="sm" onClick={onRetry}>{tr("common.retry")}</Button> : undefined}
            >
              {tr("browser.reader.failed")}
            </Notice>
          </div>
        ) : reader.paragraphs.length === 0 ? (
          reader.status === "loading" ? (
            <p className="browser-reader-column browser-reader-loading" role="status">
              <Spinner size="sm" />
              <span>{tr("browser.reader.loading")}</span>
            </p>
          ) : (
            <div className="browser-reader-column" role="status">
              <EmptyState variant="panel" mark={<Icon icon={DocsIcon} size="xl" />} title={tr("browser.reader.empty")} />
            </div>
          )
        ) : (
          <article className="browser-reader-column browser-reader-body" dir="auto">
            {readerBlocks(reader.paragraphs).map((block, index) => (
              block.kind === "break" ? <hr key={index} /> :
              block.kind === "text" ? <p key={index}>{block.text}</p> : (
                <div
                  key={index}
                  className="browser-reader-table"
                  role="table"
                  style={{ gridTemplateColumns: `repeat(${Math.max(...block.rows.map((cells) => cells.length))}, minmax(0, auto))` }}
                >
                  {block.rows.map((cells, row) => (
                    <div key={row} role="row" className={row === 0 ? "browser-reader-row browser-reader-row--head" : "browser-reader-row"}>
                      {cells.map((cell, column) => <span key={column} role="cell">{cell}</span>)}
                    </div>
                  ))}
                </div>
              )
            ))}
          </article>
        )}
      </div>
    </section>
  );
}
