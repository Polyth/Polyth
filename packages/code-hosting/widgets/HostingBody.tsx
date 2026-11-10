import { useMemo } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { parseHostingBody, type HostingBodySegment } from "./bodyHtml.ts";

/** A provider body (PR/issue description or comment) as the shared Markdown
 *  renderer understands it: Markdown runs, plus real `<details>` blocks that
 *  stay collapsible — Dependabot puts every dependency's release notes in one.
 *  See `bodyHtml.ts` for the HTML subset that becomes Markdown. */
export default function HostingBody({ host, text, keyBase }: { host: WebPackageHost; text: string; keyBase: string }) {
  const segments = useMemo(() => parseHostingBody(text), [text]);
  const MarkdownDoc = host.ui.components.MarkdownDoc;

  const render = (items: HostingBodySegment[], base: string) => items.map((segment, index) => {
    const key = `${base}-${index}`;
    if (segment.kind === "details") {
      const body = render(segment.segments, key);
      if (!segment.summary) return <div key={key} className="pr-details-body">{body}</div>;
      return (
        <details key={key} className="pr-details" open={segment.open || undefined}>
          <summary>{segment.summary}</summary>
          <div className="pr-details-body">{body}</div>
        </details>
      );
    }
    return <MarkdownDoc key={key} text={segment.text} keyBase={key} />;
  });

  return <>{render(segments, keyBase)}</>;
}
