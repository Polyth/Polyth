// What a person does with a bookmark, shared by the button under an answer, the
// panel and the walk bar. Every outcome speaks through the host's one notice
// stack; a removal can always be undone.
import type { WebPackageHost } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { BOOKMARKS_SURFACE_ID } from "./ids.ts";
import type { BookmarkView } from "../src/bookmarks.ts";
import { removeBookmark, restoreBookmark, saveBookmark, type SaveBookmarkInput } from "./client.ts";

const UNDO_MS = 6_000;

function report(host: WebPackageHost, title: string, cause: unknown): void {
  host.notifications?.show({
    kind: "error",
    title,
    ...(cause instanceof Error && cause.message ? { body: cause.message } : {}),
  });
}

export async function saveWithUndo(host: WebPackageHost, input: SaveBookmarkInput): Promise<BookmarkView | null> {
  try {
    const bookmark = await saveBookmark(input);
    host.notifications?.show({
      id: "bookmarks.saved",
      kind: "success",
      title: tr("bookmarks.saved"),
      duration: UNDO_MS,
      actions: [{ label: tr("bookmarks.undo"), run: () => { void removeQuietly(host, bookmark.id); } }],
    });
    return bookmark;
  } catch (cause) {
    report(host, tr("bookmarks.failed.save"), cause);
    return null;
  }
}

async function removeQuietly(host: WebPackageHost, id: string): Promise<void> {
  try {
    await removeBookmark(id);
  } catch (cause) {
    report(host, tr("bookmarks.failed.remove"), cause);
  }
}

export async function removeWithUndo(host: WebPackageHost, id: string): Promise<void> {
  try {
    const removed = await removeBookmark(id);
    host.notifications?.show({
      id: "bookmarks.removed",
      kind: "info",
      title: tr("bookmarks.removed"),
      duration: UNDO_MS,
      actions: [{
        label: tr("bookmarks.undo"),
        run: () => {
          void restoreBookmark(removed).catch((cause: unknown) => report(host, tr("bookmarks.failed.save"), cause));
        },
      }],
    });
  } catch (cause) {
    report(host, tr("bookmarks.failed.remove"), cause);
  }
}

/** Show a bookmark's place. False when the chat cannot show it any more. */
export async function revealBookmark(host: WebPackageHost, bookmark: BookmarkView, focus: boolean): Promise<boolean> {
  const reveal = host.conversation.revealEvent;
  if (!reveal || !bookmark.sessionId || bookmark.eventSeq === undefined || bookmark.chat !== "open") return false;
  try {
    const passage = bookmark.kind === "fragment" ? bookmark.quote : bookmark.kind === "section" ? bookmark.title : undefined;
    return await reveal(bookmark.sessionId, bookmark.eventSeq, { focus, ...(passage ? { passage } : {}) });
  } catch {
    return false;
  }
}

export const openBookmarksPane = (host: WebPackageHost): boolean => host.navigation.openWorkspacePane(BOOKMARKS_SURFACE_ID);

export function reportMissingPlace(host: WebPackageHost): void {
  host.notifications?.show({ id: "bookmarks.place", kind: "warning", title: tr("bookmarks.jump.failed") });
}

export function reportFailure(host: WebPackageHost, title: string, cause: unknown): void {
  report(host, title, cause);
}

/** Hand a Markdown file to the person: the share sheet on a touch device that
 *  can share files, else a download. "cancelled" means they closed the sheet. */
export async function deliverMarkdownFile(fileName: string, markdown: string): Promise<"shared" | "downloaded" | "cancelled"> {
  const file = new File([markdown], fileName, { type: "text/markdown;charset=utf-8" });
  const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  if (coarse && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return "shared";
    } catch (cause) {
      if ((cause as { name?: unknown })?.name === "AbortError") return "cancelled";
      // A share that failed for any other reason still ends in a file.
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  return "downloaded";
}
