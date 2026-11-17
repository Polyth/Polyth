// Chat attachments land in the root's `_inbox/` (composer uploads, staged
// tracker images, copies materialized into a linked worktree or SSH host).
// They belong to Polyth's chats, never to the project's history, so the folder
// carries its own `.gitignore` of `*`: Git skips every file in it — that
// `.gitignore` included — in status, `git add -A` and commits, in any
// repository, without Polyth editing the project's own ignore rules.
import path from "node:path";
import type { FileService } from "./index.ts";

export const INBOX_DIR = "_inbox";
export const INBOX_GITIGNORE_PATH = `${INBOX_DIR}/.gitignore`;
export const INBOX_GITIGNORE = "# Polyth chat attachments: kept out of source control.\n*\n";

/** Whether a root-relative path is the attachment inbox or inside it, however
 *  the path is spelled. */
export function isInboxPath(rel: string): boolean {
  const clean = path.posix.normalize(rel.replaceAll("\\", "/")).replace(/^(\.?\/)+/, "");
  return clean === INBOX_DIR || clean === `${INBOX_DIR}/` || clean.startsWith(`${INBOX_DIR}/`);
}

/** Give `root`'s `_inbox/` its `.gitignore` when it has none; one already
 *  there (a person's own included) is left as it is. Best effort: a failure is
 *  reported, never thrown, so it cannot cost anyone their upload. */
export async function ensureInboxIgnored(files: FileService, root: string): Promise<void> {
  try {
    await files.stat(root, INBOX_GITIGNORE_PATH);
    return;
  } catch {
    // Missing: write it below.
  }
  try {
    await files.writeBytes(root, INBOX_GITIGNORE_PATH, new TextEncoder().encode(INBOX_GITIGNORE));
  } catch (error) {
    console.warn(`[polyth] ${INBOX_GITIGNORE_PATH} was not written in ${root}`, error);
  }
}

/** `files` whose every write into the top-level `_inbox/` is preceded by
 *  `ensureInboxIgnored`. Reads and removals pass straight through. */
export function withIgnoredInbox(files: FileService): FileService {
  const guard = async (root: string, rel: string): Promise<void> => {
    if (isInboxPath(rel)) await ensureInboxIgnored(files, root);
  };
  return {
    ...files,
    async write(root, rel, content, opts) {
      await guard(root, rel);
      return files.write(root, rel, content, opts);
    },
    async writeBytes(root, rel, data) {
      await guard(root, rel);
      return files.writeBytes(root, rel, data);
    },
    async mkdir(root, rel) {
      await guard(root, rel);
      return files.mkdir(root, rel);
    },
    async rename(root, from, to) {
      await guard(root, to);
      return files.rename(root, from, to);
    },
  };
}
