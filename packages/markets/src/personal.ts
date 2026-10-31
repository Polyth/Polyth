// Watchlists and the portfolio belong to ONE person in ONE Space (Spaces §14.6):
//   <dataDir>/people/<userId>/packages/markets/spaces/<spaceId>/{watchlists,portfolio}.json
// Market data itself (quotes, candles, screener) is public and stays shared.
//
// Files written before person ownership live in the Space's package directory.
// They are moved, once, to the first request made by a member whose role is
// `owner`; every other member starts from the defaults. Nothing is copied to
// anyone else and a person's existing file is never overwritten.
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpaceContext } from "@polyth/contracts";
import type { PeopleHost, ServerPackageHost } from "@polyth/plugins";

/** What `loadWatchlists` / `savePortfolio` need: a directory for the package's files. */
export interface MarketsDataDir {
  packageDir(packageId: string): string;
}

export type MarketsPersonHost = Pick<ServerPackageHost, "spaceStorage"> & { people?: PeopleHost | undefined };

const PACKAGE_ID = "markets";
const FILES = ["watchlists.json", "portfolio.json"] as const;
const SPACE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$/;

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (cause) {
    if ((cause as { code?: string }).code !== "EXDEV") throw cause;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

/** The calling person's data directory in this Space. Refuses system work. */
export function personalMarketsDir(host: MarketsPersonHost, space: SpaceContext): MarketsDataDir {
  const userId = space.userId;
  if (
    typeof userId !== "string"
    || userId === ""
    || userId.startsWith("system:")
    || (space as { authority?: { kind?: unknown } }).authority?.kind === "system"
  ) {
    throw fail("forbidden", "Watchlists and portfolio belong to a signed-in person; system work cannot use them");
  }
  if (!SPACE_SEGMENT.test(space.spaceId)) throw fail("invalid-input", "invalid Space id");
  const people = host.people;
  if (!people) throw fail("unavailable", "Markets needs person-owned storage, which this host does not provide");
  const dir = people.storage(userId, PACKAGE_ID).path(join("spaces", space.spaceId));
  mkdirSync(dir, { recursive: true });
  if (space.role === "owner") {
    const legacyDir = host.spaceStorage(space).packageDir(PACKAGE_ID);
    for (const name of FILES) {
      const legacy = join(legacyDir, name);
      const target = join(dir, name);
      if (existsSync(legacy) && !existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true });
        moveFile(legacy, target);
      }
    }
  }
  return { packageDir: () => dir };
}
