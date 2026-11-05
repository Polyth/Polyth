// What happens to a person's private chats, rooms and notes when their account
// ends (Spaces §14.5): nobody can open them, not even the instance owner, and
// nothing transfers them. The owner can see how much there is, never what it is,
// and their one choice is to erase it for good.
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { Project, SessionPersistence, SessionProjection, SessionService, SpaceContext } from "@polyth/contracts";
import type { RouteHandler } from "../http.ts";
import type { ProjectRegistry } from "../projects.ts";
import { canonicalSecurity } from "../runtimeSecurity.ts";
import { privateSessionOwner } from "../sessionSharing.ts";

interface EraseDeps {
  projects: ProjectRegistry;
  /** Canonical deletion, so the chat's resource ends with it: a room can't be
   *  removed while one of its chats still has a resource. */
  deleteChat(session: SessionProjection): Promise<void>;
  /** Every chat, including ones that failed at startup and archived ones: the
   *  session list leaves some out, and those hold someone's words too. */
  store: Pick<SessionPersistence, "projections" | "eventsOfTypes">;
  /** Canonical removal, so the project's resource ends with it. */
  removeProject(project: Project): Promise<void>;
}

const ATTACHMENT_PAGE = 500;

/** The attachments this person sent into a chat: staged in the project's shared
 *  `_inbox` folder, which outlives the chat. Theirs only: a fork of someone else's
 *  chat carries that person's messages too. */
async function attachmentNames(userId: string, session: SessionProjection, store: EraseDeps["store"]): Promise<string[]> {
  if (!store.eventsOfTypes) return [];
  const names: string[] = [];
  let after = 0;
  for (;;) {
    const page = await store.eventsOfTypes(session.id, ["user/message"], after, Number.MAX_SAFE_INTEGER, ATTACHMENT_PAGE);
    for (const event of page) {
      const data = event.data as { author?: { userId?: unknown }; attachments?: Array<{ path?: unknown }> };
      if (data.author?.userId !== undefined && data.author.userId !== userId) continue;
      for (const attachment of data.attachments ?? []) {
        const path = attachment.path;
        if (typeof path !== "string" || !path.startsWith("_inbox/")) continue;
        const name = path.slice("_inbox/".length);
        // Exactly one name inside the folder: nothing a message says can point
        // this delete anywhere else.
        if (name && name !== "." && name !== ".." && basename(name) === name) names.push(name);
      }
    }
    if (page.length < ATTACHMENT_PAGE) return names;
    after = page.at(-1)!.seq;
  }
}

/** Delete the chats only this person could open, with what they attached to
 *  them, then their private rooms and personal project with their folders. A
 *  failure leaves the rest unreadable, never exposed, and is reported so the
 *  owner can retry. */
export async function erasePrivateChats(userId: string, deps: EraseDeps): Promise<{ chats: number; rooms: number; failed: number }> {
  let chats = 0;
  let failed = 0;
  const theirs = (await deps.store.projections()).filter((session) =>
    !!session?.spaceId && privateSessionOwner(session.spaceId, session.id) === userId);
  const byId = new Map(theirs.map((session) => [session.id, session]));
  const depth = (session: SessionProjection): number => {
    let levels = 0;
    for (let parent = session.parentId; parent && levels < 32; parent = byId.get(parent)?.parentId) levels += 1;
    return levels;
  };
  // Subagents first: a resource can't go while a child still depends on it.
  for (const session of theirs.sort((left, right) => depth(right) - depth(left))) {
    try {
      const names = await attachmentNames(userId, session, deps.store);
      const project = names.length > 0 ? deps.projects.projectById(session.projectId) : undefined;
      await deps.deleteChat(session);
      chats += 1;
      const roots = [project && !project.remote ? project.path : undefined, session.worktreePath];
      for (const root of new Set(roots)) {
        if (!root) continue;
        for (const name of names) rmSync(join(root, "_inbox", name), { force: true });
      }
    } catch (cause) {
      // Already gone: a retry after a partial erase.
      if ((cause as { code?: unknown } | null)?.code === "not-found") continue;
      failed += 1;
      console.warn(`[polyth] could not erase private chat ${session.id}`, cause);
    }
  }
  let rooms = 0;
  const removeFolder = (project: Project): void => {
    // Only ever a folder under the person's own storage: `provision` chose it.
    if (!project.remote) rmSync(project.path, { recursive: true, force: true });
  };
  for (const room of deps.projects.privateProjectsOwnedBy(userId)) {
    try {
      await deps.removeProject(room);
      removeFolder(room);
      rooms += 1;
    } catch (cause) {
      failed += 1;
      console.warn(`[polyth] could not erase private room ${room.id}`, cause);
    }
  }
  return { chats, rooms, failed };
}

/** Entries to walk before the answer is good enough: it is shown as a rough size. */
const MAX_WALKED_ENTRIES = 100_000;

function folderBytes(root: string): number {
  let total = 0;
  let walked = 0;
  const pending = [root];
  while (pending.length > 0 && walked < MAX_WALKED_ENTRIES) {
    const dir = pending.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      walked += 1;
      const path = join(dir, entry.name);
      // Links are not followed: what they point at is not necessarily theirs.
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try { total += lstatSync(path).size; } catch { /* gone since the listing */ }
      }
    }
  }
  return total;
}

interface VolumeDeps {
  projects: Pick<ProjectRegistry, "privateProjectsOwnedBy">;
  sessions: Pick<SessionService, "list">;
  store: Pick<SessionPersistence, "eventBytes">;
  /** Packages that hold this person's data (their notes). */
  measures: Iterable<(userId: string) => number | Promise<number>>;
}

/** How much only this person can open. One number on purpose: no titles and no
 *  counts, because how many chats someone keeps is already something about them. */
export async function privateDataBytes(userId: string, deps: VolumeDeps): Promise<number> {
  let total = 0;
  for (const session of await deps.sessions.list()) {
    if (!session.spaceId || privateSessionOwner(session.spaceId, session.id) !== userId) continue;
    total += await deps.store.eventBytes?.(session.id) ?? 0;
  }
  for (const project of deps.projects.privateProjectsOwnedBy(userId)) {
    if (!project.remote) total += folderBytes(project.path);
  }
  for (const measure of deps.measures) {
    try { total += await measure(userId); }
    catch (cause) { console.warn("[polyth] a package could not measure a person's data", cause); }
  }
  return total;
}

const denied = (message: string, code = "forbidden"): Error => Object.assign(new Error(message), { code });

/**
 * Instance owner only, unlisted in the remote policy (a paired device is denied
 * by default) and never about anything but size:
 *
 * - `GET /api/accounts/:id/private-data` answers `{ bytes }`.
 * - `POST /api/accounts/:id/erase-private-data` needs a recent sign-in, because
 *   it can't be undone, and an account disabled for good, so the person can't
 *   come back to find it gone.
 */
export function privateDataRoutes(deps: {
  /** Answers how many things it could not erase. */
  erase(userId: string): Promise<{ failed: number }>;
  volume(userId: string): Promise<number>;
}): RouteHandler {
  return async (rc) => {
    const match = rc.path.match(/^\/api\/accounts\/([^/]+)\/(private-data|erase-private-data)$/);
    if (!match) return false;
    const [, encoded, action] = match;
    if (rc.method !== (action === "private-data" ? "GET" : "POST")) return false;
    const security = canonicalSecurity();
    if (!security) throw denied("Accounts need canonical identity", "unsupported");
    const space = rc.space as SpaceContext & { instanceOwner?: boolean };
    if (space.instanceOwner !== true) throw denied("Only the instance owner can do this");
    const target = decodeURIComponent(encoded!);
    const account = security.control.get<{ status: string }>(
      "SELECT p.status FROM principals p JOIN users u ON u.id=p.id WHERE p.id=? AND p.kind='user'",
      target,
    );
    if (!account) throw denied("Account not found", "not-found");
    if (action === "private-data") {
      rc.json(200, { bytes: await deps.volume(target) });
      return true;
    }
    if (account.status !== "disabled") {
      throw denied("Disable this account for good before erasing its private data", "conflict");
    }
    try {
      security.http.requireRecentHuman(rc.req);
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code;
      // The settings page asks for the password and retries on exactly this.
      if (code === "reauth-required") {
        rc.json(403, { error: code, message: "Sign in again to confirm this action" });
        return true;
      }
      throw denied("Only a signed-in browser session can erase private data");
    }
    const { failed } = await deps.erase(target);
    security.control.transaction(() => security.control.audit(space.userId, failed === 0 ? "identity.private-data-erased" : "identity.private-data-erase-incomplete", target));
    // Never "done" while something remains: the owner can run it again.
    if (failed > 0) {
      rc.json(500, { error: "erase-incomplete", message: "Some of this person's private data couldn't be erased. Try again." });
      return true;
    }
    rc.json(200, { ok: true });
    return true;
  };
}
