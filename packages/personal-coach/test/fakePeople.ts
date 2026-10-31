import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { PeopleHost } from "@polyth/plugins";

/** Person storage under `<root>/people/<userId>/packages/<packageId>`; the rest of the facade is unused here. */
export function fakePeople(root: string): PeopleHost {
  const unused = (): never => { throw new Error("not used by Personal Coach"); };
  return {
    storage(userId, packageId) {
      // Same rule as the server implementation (packages/server/src/people.ts).
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(userId)) throw Object.assign(new Error("userId is invalid"), { code: "invalid-input" });
      const dir = resolve(root, "people", userId, "packages", packageId);
      mkdirSync(dir, { recursive: true });
      return {
        root: dir,
        path(relative) {
          const full = resolve(dir, relative);
          if (full !== dir && !full.startsWith(dir + sep)) throw new Error("invalid-path");
          return full;
        },
      };
    },
    vault: unused,
    enabled: unused,
    setEnabled: unused,
    servicePolicy: unused,
    setServicePolicy: unused,
    isMember: () => true,
  };
}

export const personFile = (root: string, userId: string, spaceId: string): string =>
  join(root, "people", userId, "packages", "personal-coach", "spaces", spaceId, "coach.db");
