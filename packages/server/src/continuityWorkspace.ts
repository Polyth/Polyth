import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContinuityWorkspace } from "@polyth/session";
const exec = promisify(execFile);

/** Current facts only. No diff bodies or source content enter continuity. */
export async function continuityWorkspace(cwd: string, remote = false): Promise<ContinuityWorkspace> {
  if (remote) return { cwd };
  try {
    const [head, status] = await Promise.all([
      exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 1500, maxBuffer: 8192 }),
      exec("git", ["status", "--porcelain=v1", "--branch"], { cwd, timeout: 1500, maxBuffer: 64 * 1024 }),
    ]);
    const [branch, ...files] = status.stdout.trimEnd().split("\n");
    return { cwd, head: head.stdout.trim(), branch: branch?.slice(3).split("...")[0], dirty: files.length > 0, files: files.slice(0, 30).map((line) => line.slice(3, 203)) };
  } catch { return { cwd }; }
}
