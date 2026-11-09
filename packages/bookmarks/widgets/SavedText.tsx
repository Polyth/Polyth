// What a bookmark holds, read the same in the panel and in the chat's popover:
// the saved text with the chat's own answer styles, and its links.
import { useEffect, useState } from "react";
import { Button, ExternalLinkIcon, Icon, Spinner } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { MarkdownDoc } from "../../../apps/web/src/markdown.tsx";
import type { BookmarkLink, BookmarkView } from "../src/bookmarks.ts";
import { readBookmarkBody } from "./client.ts";

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function SavedText({ bookmark }: { bookmark: BookmarkView }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setFailed(false);
    void readBookmarkBody(bookmark).then(
      (body) => { if (current) setText(body); },
      () => { if (current) setFailed(true); },
    );
    return () => { current = false; };
  }, [bookmark.id, bookmark.revision, attempt]);
  if (failed) {
    return (
      <p className="bm-status" role="alert">
        {tr("bookmarks.failed.text")}
        <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>{tr("bookmarks.retry")}</Button>
      </p>
    );
  }
  if (text === null) return <p className="bm-status" role="status"><Spinner size="sm" />{tr("bookmarks.loading")}</p>;
  if (!text.trim()) return null;
  // The chat's own answer styles: links, lists and code read as they did there.
  return (
    <div className="msg assistant bm-text">
      <div className="bubble" dir="auto">
        <MarkdownDoc text={text} keyBase={`bookmark-${bookmark.id}`} />
      </div>
    </div>
  );
}

export function LinkRow({ link }: { link: BookmarkLink }) {
  return (
    <li>
      <a className="bm-link" href={link.url} target="_blank" rel="noopener noreferrer">
        <span className="bm-link-text">
          <bdi className="bm-link-label">{link.label}</bdi>
          <span className="bm-link-host">{hostOf(link.url)}</span>
        </span>
        <span className="bm-link-glyph" aria-hidden="true"><Icon icon={ExternalLinkIcon} size="sm" /></span>
      </a>
    </li>
  );
}
