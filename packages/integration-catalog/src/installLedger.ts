// Which installations this catalog created, so it removes only those.
//
// A server keeps the entry id as its name, so matching by name is how the page
// shows state — but a person may have created a server called `linear` by hand
// and it must survive a catalog uninstall. The ledger is the ownership record;
// it lives in the package's own Space directory and never holds a secret.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type { InstallScope } from "./install.ts";

const FILE = "installs.json";

export interface InstallRecord {
  entryId: string;
  serverId: string;
  scope: InstallScope;
  projectId?: string;
  /** Who installed it; a person-scoped record belongs to them alone. */
  userId?: string;
  at: number;
}

interface LedgerDocument {
  version: 1;
  installs: InstallRecord[];
}

const isRecord = (value: unknown): value is InstallRecord => {
  const row = value as Partial<InstallRecord> | null;
  return typeof row?.entryId === "string"
    && typeof row.serverId === "string"
    && (row.scope === "project" || row.scope === "space" || row.scope === "person")
    && typeof row.at === "number";
};

/** A Space's catalog ledger: read, add, forget. Writes are atomic, so a crash
 *  mid-update leaves the previous list instead of a truncated file. */
export function createInstallLedger(directory: string | undefined) {
  const list = (): InstallRecord[] => {
    if (!directory) return [];
    let raw: string;
    try {
      raw = readFileSync(join(directory, FILE), "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LedgerDocument>;
      return Array.isArray(parsed.installs) ? parsed.installs.filter(isRecord) : [];
    } catch {
      // An unreadable ledger must not break the page; it only means "nothing
      // was installed by the catalog", and a fresh install rewrites it.
      return [];
    }
  };

  const write = (installs: InstallRecord[]): void => {
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    atomicWriteSync(join(directory, FILE), `${JSON.stringify({ version: 1, installs } satisfies LedgerDocument, null, 2)}\n`);
  };

  return {
    list,
    add(record: InstallRecord): void {
      write([...list().filter((row) => row.serverId !== record.serverId), record]);
    },
    forget(serverId: string): void {
      write(list().filter((row) => row.serverId !== serverId));
    },
    forEntry(entryId: string): InstallRecord[] {
      return list().filter((row) => row.entryId === entryId);
    },
  };
}

export type InstallLedger = ReturnType<typeof createInstallLedger>;
