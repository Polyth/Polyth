import { useEffect, useRef, useState } from "react";
import type { BrowserContext } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, CloseIcon, IconButton, Textarea } from "../../../apps/web/src/components/ui/index.ts";
import { compactPageIdentity } from "./browserPreview.ts";

export function BrowserContextPreview({ context, onAdd, onDiscard }: {
  context: BrowserContext; onAdd: (note: string) => void; onDiscard: () => void;
}) {
  const [note, setNote] = useState("");
  const addRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { addRef.current?.focus(); }, []);
  const artifact = context.crop ?? context.screenshot;
  const kind = tr(`browser.context.${context.type}`);
  const label = context.quote || context.element?.name || context.element?.text || context.title || kind;
  const bounds = context.region?.pixels ?? context.element?.bounds;
  return (
    <section className="browser-context-preview" aria-label={tr("browser.context.preview")}>
      <div className="browser-context-preview-head">
        {artifact && <img className="browser-context-thumbnail" src={api.browserArtifactUrl(artifact.id)} alt={kind} />}
        <div className="browser-context-identity">
          <span className="browser-context-eyebrow">{kind} · {compactPageIdentity(context.url)}</span>
          <strong>{label}</strong>
          <span className="browser-context-location">
            {context.point ? `${tr("browser.context.point")} (${context.point.x}, ${context.point.y})` : bounds ? `${bounds.width} × ${bounds.height} · (${bounds.x}, ${bounds.y})` : `${context.viewport.width} × ${context.viewport.height}`}
          </span>
        </div>
        <IconButton icon={CloseIcon} size="sm" label={tr("browser.context.discard")} onClick={onDiscard} />
      </div>
      <details className="browser-context-details">
        <summary>{tr("browser.context.details")}</summary>
        <dl>
          <dt>{tr("previewview.page")}</dt><dd>{context.title || context.url}</dd>
          <dt>{tr("previewview.url")}</dt><dd>{context.url}</dd>
          {context.element && <><dt>{tr("browser.context.element")}</dt><dd>{[context.element.tag, context.element.role].filter(Boolean).join(" · ")}</dd></>}
          {context.element?.selector && <><dt>{tr("previewview.cssSelector")}</dt><dd><code>{context.element.selector}</code></dd></>}
          {context.element?.documentBounds && <><dt>{tr("browser.context.documentPosition")}</dt><dd>({context.element.documentBounds.x}, {context.element.documentBounds.y})</dd></>}
          <dt>{tr("previewview.viewportSize")}</dt><dd>{context.viewport.width} × {context.viewport.height}</dd>
          {context.intersecting?.length ? <><dt>{tr("browser.context.elements")}</dt><dd>{context.intersecting.map((el, i) => <div key={i}>{el.name || el.text || el.tag} {el.selector && <code>{el.selector}</code>}</div>)}</dd></> : null}
        </dl>
      </details>
      <div className="browser-context-preview-actions">
        <Textarea rows={1} maxLength={2000} value={note} placeholder={tr("browser.context.note")} aria-label={tr("browser.context.note")} onChange={(event) => setNote(event.target.value)} />
        <Button ref={addRef} size="sm" variant="primary" onClick={() => onAdd(note)}>{tr("browser.context.addToMessage")}</Button>
      </div>
    </section>
  );
}
