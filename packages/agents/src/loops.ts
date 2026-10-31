// Markdown-managed loops: <project>/.agents/loops/*.md with strict
// frontmatter. Identity is projectId + frontmatter `id`, never the filename,
// so a rename keeps history. Parse errors are surfaced per file and never
// delete healthy tasks — reconciliation handles that in the schedule service.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateCron } from "./cron.ts";
import { validateTrigger } from "./agentEvents.ts";
import { parseAgentFile, type AgentFileSpec } from "./agentFile.ts";

export interface LoopSpec {
  id: string;
  title: string;
  cron: string;
  timeZone: string;
  enabled: boolean;
  agentProfile?: string;
  prompt: string;
  /** Present for `.agents/agents` files: every other setting of the agent.
   *  `cron` is empty when the agent has no schedule. */
  file?: AgentFileSpec;
}

export interface LoopFileResult {
  path: string;
  digest: string;
  loop?: LoopSpec;
  parseError?: string;
}

const MAX_BYTES = 256 * 1024;

/** Strict frontmatter parser: `---` fence, `key: value` lines, body after. */
export function parseLoopFile(text: string): { loop?: LoopSpec; parseError?: string } {
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return { parseError: "loop file exceeds 256 KiB" };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { parseError: "missing frontmatter (--- fenced block)" };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) return { parseError: `invalid frontmatter line: ${line.slice(0, 60)}` };
    meta[kv[1]!] = kv[2]!.trim().replace(/^"(.*)"$/, "$1");
  }
  const id = meta.id ?? "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) return { parseError: "frontmatter id must be a short lowercase identifier" };
  const cron = meta.cron ?? "";
  const timeZone = meta.timeZone ?? "UTC";
  const v = validateCron(cron, timeZone);
  if (!v.ok) return { parseError: `cron: ${v.error}` };
  const prompt = m[2]!.trim();
  if (!prompt) return { parseError: "loop body (prompt) is empty" };
  return {
    loop: {
      id,
      title: meta.title || id,
      cron,
      timeZone,
      enabled: meta.enabled !== "false",
      ...(meta.agentProfile ? { agentProfile: meta.agentProfile } : {}),
      prompt,
    },
  };
}

/** An agent file as a managed task spec, validated with the server's rules. */
export function parseAgentDefinition(text: string): { loop?: LoopSpec; parseError?: string } {
  const parsed = parseAgentFile(text, {
    cron: (cron, timeZone) => { const v = validateCron(cron, timeZone); return v.ok ? undefined : v.error; },
    wake: validateTrigger,
  });
  if (!parsed.spec) return { parseError: parsed.error };
  const spec = parsed.spec;
  return {
    loop: {
      id: spec.id,
      title: spec.name,
      cron: spec.schedule?.cron ?? "",
      timeZone: spec.schedule?.timeZone ?? "UTC",
      enabled: spec.enabled,
      ...(spec.agentProfile ? { agentProfile: spec.agentProfile } : {}),
      prompt: spec.charter,
      file: spec,
    },
  };
}

const isRealDir = (path: string): boolean => {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
};

/** Scan <projectRoot>/.agents/agents and .agents/loops for *.md files.
 *  Symlinked files and directories are skipped (no traversal out of the
 *  project); each file reports either a spec or an error. Ids are unique
 *  across both directories; agent files win over loops of the same id. */
export function scanLoopsDir(projectRoot: string): LoopFileResult[] {
  if (!isRealDir(join(projectRoot, ".agents"))) return [];
  const out: LoopFileResult[] = [];
  for (const [subdir, parse] of [["agents", parseAgentDefinition], ["loops", parseLoopFile]] as const) {
    const dir = join(projectRoot, ".agents", subdir);
    if (!isRealDir(dir)) continue;
    out.push(...scanDir(dir, parse));
  }
  return dedupe(out);
}

function scanDir(dir: string, parse: (text: string) => { loop?: LoopSpec; parseError?: string }): LoopFileResult[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LoopFileResult[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      if (st.size > MAX_BYTES) {
        out.push({ path, digest: "", parseError: "loop file exceeds 256 KiB" });
        continue;
      }
      const text = readFileSync(path, "utf8");
      const digest = createHash("sha256").update(text).digest("hex");
      out.push({ path, digest, ...parse(text) });
    } catch (e) {
      out.push({ path, digest: "", parseError: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

function dedupe(out: LoopFileResult[]): LoopFileResult[] {
  // Duplicate ids across files: keep the first (agents, then loops; sorted), flag the rest.
  const seen = new Map<string, string>();
  for (const r of out) {
    if (!r.loop) continue;
    const prior = seen.get(r.loop.id);
    if (prior) {
      r.parseError = `duplicate loop id "${r.loop.id}" (already defined in ${prior})`;
      delete r.loop;
    } else {
      seen.set(r.loop.id, r.path);
    }
  }
  return out;
}
