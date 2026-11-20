import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The relay's GitHub target: one private repository, the branch its
 *  attachments live on, and a fine-grained token limited to that repository
 *  (Issues RW + Contents RW). Read from `<keysDir>/github.json` and
 *  `<keysDir>/github-token`, re-read when either file's mtime changes. */
export interface GithubConfig {
  repo: string;
  branch: string;
  token: string;
}

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._-]{1,100}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,255}$/;
const DEFAULT_BRANCH = "attachments";

export function githubFromDir(dir: string): () => GithubConfig | undefined {
  const configFile = join(dir, "github.json");
  const tokenFile = join(dir, "github-token");
  let stamp = "";
  let config: GithubConfig | undefined;
  return () => {
    let next: string;
    try { next = `${statSync(configFile).mtimeMs}:${statSync(tokenFile).mtimeMs}`; } catch { next = ""; }
    if (next === stamp) return config;
    stamp = next;
    config = undefined;
    if (!next) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(configFile, "utf8")) as { repo?: unknown; branch?: unknown };
      const branch = parsed.branch === undefined ? DEFAULT_BRANCH : parsed.branch;
      const token = readFileSync(tokenFile, "utf8").trim();
      if (typeof parsed.repo !== "string" || !REPO.test(parsed.repo)) return undefined;
      if (typeof branch !== "string" || branch.includes("..") || !BRANCH.test(branch)) return undefined;
      if (!TOKEN.test(token)) return undefined;
      config = { repo: parsed.repo, branch, token };
    } catch {
      return undefined;
    }
    return config;
  };
}
