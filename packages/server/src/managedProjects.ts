// The Polyth folder: projects whose folder the server chooses, so a person who
// has never thought about folders can still start one. The client only names
// the project; no path ever comes from a request.
//
//   Polyth Desktop  ~/Polyth/<Name>, a real folder the person can open and drop
//                   files into.
//   Any server      <space storage>/projects/<uuid>. A server's home directory
//                   belongs to the host (in Docker it is not even on the data
//                   volume), and Space storage goes with the Space.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  allowsHostFilesystemBrowsing,
  type ManagedProjectInput,
  type ManagedProjectLocationDto,
  type SpaceContext,
} from "@polyth/contracts";
import { parseProjectComposition, type ProjectComposition } from "@polyth/contracts/project-composition";
import { resolveInside } from "@polyth/tenancy";

const HOME_ROOT = "Polyth";
const HOME_ROOT_LABEL = `~/${HOME_ROOT}`;
const STORAGE_ROOT = "projects";
const FALLBACK_FOLDER = "Project";
const MAX_PROJECT_NAME = 120;
/** Under the 255-byte NAME_MAX of common filesystems, with room for " 1000". */
const MAX_FOLDER_BYTES = 200;
const MAX_FOLDER_COPIES = 1000;
const CLIENT_OPERATION_ID = /^[A-Za-z0-9_-]{8,128}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const invalid = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

/** Polyth Desktop marks its in-process server (apps/desktop/src/main.ts). The
 *  deployment profile cannot answer this: `local-trusted` is also the default
 *  on a server, and a Desktop owner may add a password later. */
const runsOnDesktop = (): boolean => process.env.POLYTH_DESKTOP === "1";

export interface ManagedProjectRequest {
  name: string;
  composition?: ProjectComposition;
  clientOperationId?: string;
}

/** Reject a bad request before any folder exists. */
export function parseManagedProjectInput(input: ManagedProjectInput): ManagedProjectRequest {
  const name = typeof input?.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (!name) throw invalid("name is required");
  if (name.length > MAX_PROJECT_NAME) throw invalid(`name must be at most ${MAX_PROJECT_NAME} chars`);
  const clientOperationId: unknown = input.clientOperationId;
  if (clientOperationId !== undefined && (typeof clientOperationId !== "string" || !CLIENT_OPERATION_ID.test(clientOperationId))) {
    throw invalid("clientOperationId is invalid");
  }
  return {
    name,
    ...(input.composition !== undefined ? { composition: parseProjectComposition(input.composition) } : {}),
    ...(clientOperationId !== undefined ? { clientOperationId } : {}),
  };
}

/** A project name as one safe path segment on any desktop OS. It stays readable
 *  in the person's own language: only what a filesystem refuses, or what could
 *  disguise the name (control and bidi characters), goes away. */
export function managedFolderName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}/\\:*?"<>|]+/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  const characters = Array.from(cleaned);
  while (Buffer.byteLength(characters.join("")) > MAX_FOLDER_BYTES) characters.pop();
  const short = characters.join("").replace(/[.\s]+$/, "");
  if (!short) return FALLBACK_FOLDER;
  return WINDOWS_RESERVED_NAME.test(short) ? `${FALLBACK_FOLDER} ${short}` : short;
}

/** Create a brand-new folder under `parent` and return it. `mkdir` without
 *  `recursive` fails on anything that exists, so a person's own folder is never
 *  adopted, and a registered path whose folder was deleted is never reused. */
export function reserveManagedFolder(
  parent: string,
  name: string,
  registered: (path: string) => boolean,
): string {
  mkdirSync(parent, { recursive: true });
  const base = managedFolderName(name);
  for (let copy = 1; copy <= MAX_FOLDER_COPIES; copy += 1) {
    const candidate = join(parent, copy === 1 ? base : `${base} ${copy}`);
    if (registered(candidate)) continue;
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
  }
  throw Object.assign(new Error("too many project folders share this name"), { code: "conflict" });
}

/** Where a new managed project goes. Always a folder that did not exist. */
export function managedProjectPath(
  ctx: Pick<SpaceContext, "storageDir">,
  name: string,
  registered: (path: string) => boolean,
): string {
  if (runsOnDesktop()) return reserveManagedFolder(join(homedir(), HOME_ROOT), name, registered);
  const relative = join(STORAGE_ROOT, randomUUID());
  const dir = resolveInside(ctx.storageDir, relative);
  mkdirSync(dir, { recursive: true });
  // Re-check after creation: a symlink planted in between must not move it out.
  return resolveInside(ctx.storageDir, relative);
}

/** What the new-project flow may offer in this deployment. */
export function managedProjectLocation(ctx: Pick<SpaceContext, "deployment">): ManagedProjectLocationDto {
  return {
    canChooseFolder: allowsHostFilesystemBrowsing(ctx.deployment),
    ...(runsOnDesktop() ? { rootLabel: HOME_ROOT_LABEL } : {}),
  };
}

/** The stored retry key. Hashed with the caller, so one person's id can neither
 *  find nor collide with another person's project, and no principal id or
 *  client text is kept. Without a client id a request is simply never a retry. */
export const managedOperationKey = (userId: string, clientOperationId: string | undefined): string =>
  createHash("sha256").update(`${userId}\0${clientOperationId ?? randomUUID()}`).digest("hex");

/** Drop a reserved folder nothing came to use. `rmdir` only removes an empty one. */
export function discardManagedFolder(path: string): void {
  try { rmdirSync(path); } catch { /* something is in it, or it is already gone */ }
}
