import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** The pid of a live process whose working directory is `directory` or inside
 *  it, or null. Linux reads `/proc`; elsewhere (or where `/proc` is hidden) the
 *  answer is null, so callers that need certainty must not rely on it alone. An
 *  unreadable process is skipped: it belongs to someone else. */
export function liveProcessInside(directory: string, exceptPid: number = process.pid): number | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  const roots = new Set([resolve(directory)]);
  try { roots.add(realpathSync(directory)); } catch { /* a missing directory has no process in it */ }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === exceptPid) continue;
    let cwd: string;
    try {
      cwd = readlinkSync(`/proc/${entry}/cwd`);
    } catch {
      continue;
    }
    for (const root of roots) {
      if (cwd === root || cwd.startsWith(root + sep)) return Number(entry);
    }
  }
  return null;
}
