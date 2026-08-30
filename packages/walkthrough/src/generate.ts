// Generated walkthrough support (WP11): stable diff/hunk identity, source
// digests, heuristic stage planning, and a strict parser for model-produced
// stage JSON. Pure — the server owns jobs, caching, and model calls.
import { createHash } from "node:crypto";
import type { GeneratedWalkthroughStage, GeneratedWalkthroughStop } from "@polyth/contracts";

export const WALKTHROUGH_PROMPT_VERSION = 2;
export const DEFAULT_WALKTHROUGH_INPUT_BUDGET = 96_000;

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Immutable digest of the entire captured source diff. */
export const sourceDigestOf = (diff: string): string => sha(diff);

export interface DiffHunk {
  /** stable identity: path + old/new ranges + content digest */
  id: string;
  path: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** hunk body including the @@ header line */
  text: string;
  digest: string;
}

export interface DiffFileSummary {
  path: string;
  oldPath?: string;
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse unified diff text into files + hunks with stable ids. Handles
 *  renames (`rename from/to`), binary markers, and /dev/null paths. */
export function parseUnifiedDiffText(diff: string): DiffFileSummary[] {
  const files: DiffFileSummary[] = [];
  let current: DiffFileSummary | null = null;
  let hunkLines: string[] = [];
  let hunkMeta: Omit<DiffHunk, "id" | "text" | "digest"> | null = null;

  const flushHunk = () => {
    if (!current || !hunkMeta || hunkLines.length === 0) { hunkLines = []; hunkMeta = null; return; }
    const text = hunkLines.join("\n");
    const digest = sha(text).slice(0, 16);
    const id = sha(
      `${current.path}@@-${hunkMeta.oldStart},${hunkMeta.oldLines}+${hunkMeta.newStart},${hunkMeta.newLines}:${digest}`,
    ).slice(0, 16);
    current.hunks.push({ ...hunkMeta, id, text, digest });
    hunkLines = [];
    hunkMeta = null;
  };

  const flushFile = () => {
    flushHunk();
    if (current) files.push(current);
    current = null;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      // `diff --git a/x b/y` — prefer the b-side path; quoted paths keep quotes off
      const m = /^diff --git (?:"?a\/(.*?)"?) (?:"?b\/(.*?)"?)$/.exec(line);
      const aPath = m?.[1] ?? "";
      const bPath = m?.[2] ?? aPath;
      current = {
        path: bPath || aPath || "unknown",
        ...(aPath && bPath && aPath !== bPath ? { oldPath: aPath } : {}),
        binary: false,
        hunks: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("rename from ")) { current.oldPath = line.slice("rename from ".length); continue; }
    if (line.startsWith("rename to ")) { current.path = line.slice("rename to ".length); continue; }
    if (line.startsWith("+++ b/")) { current.path = line.slice(6); continue; }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") { current.binary = true; continue; }
    const h = HUNK_RE.exec(line);
    if (h) {
      flushHunk();
      hunkMeta = {
        path: current.path,
        header: line,
        oldStart: Number(h[1]),
        oldLines: h[2] !== undefined ? Number(h[2]) : 1,
        newStart: Number(h[3]),
        newLines: h[4] !== undefined ? Number(h[4]) : 1,
      };
      hunkLines = [line];
      continue;
    }
    if (hunkMeta) hunkLines.push(line);
  }
  flushFile();
  return files;
}

const stopOf = (hunk: DiffHunk, explanation: string): GeneratedWalkthroughStop => ({
  id: hunk.id,
  path: hunk.path,
  hunkDigest: hunk.digest,
  diff: hunk.text,
  explanation,
});

const topDir = (path: string): string => {
  const i = path.indexOf("/");
  return i === -1 ? "(root)" : path.slice(0, i);
};

/** Deterministic fallback when no model is available: group hunks by top-level
 *  directory, explanations honestly state they are heuristic. */
export function heuristicStages(files: DiffFileSummary[]): GeneratedWalkthroughStage[] {
  const byDir = new Map<string, DiffHunk[]>();
  const binaries: DiffFileSummary[] = [];
  for (const f of files) {
    if (f.binary) { binaries.push(f); continue; }
    for (const h of f.hunks) {
      const dir = topDir(f.path);
      const list = byDir.get(dir) ?? [];
      list.push(h);
      byDir.set(dir, list);
    }
  }
  const stages: GeneratedWalkthroughStage[] = [...byDir.entries()].map(([dir, hunks], i) => ({
    id: `stage-${i + 1}`,
    title: `Changes in ${dir}`,
    explanation: `Heuristic grouping (no model explanation): ${hunks.length} hunk${hunks.length === 1 ? "" : "s"} under ${dir}.`,
    stops: hunks.map((h) =>
      stopOf(h, `${h.path}: ${h.header.replace(/@@ | @@.*/g, "").trim()} (heuristic — review the diff directly)`),
    ),
  }));
  if (binaries.length) {
    stages.push({
      id: `stage-${stages.length + 1}`,
      title: "Binary files",
      explanation: "Binary files changed; contents cannot be walked through.",
      stops: binaries.map((f, i) => ({
        id: `binary-${i}-${sha(f.path).slice(0, 8)}`,
        path: f.path,
        hunkDigest: "",
        diff: "(binary file changed)",
        explanation: `${f.path} is binary — no line-level walkthrough available.`,
      })),
    });
  }
  return stages;
}

const compactHunk = (hunk: DiffHunk, limit: number): string => {
  if (hunk.text.length <= limit) return hunk.text;
  const changed = hunk.text.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-"));
  const useful = [hunk.header, ...changed].join("\n");
  const contextMarker = "\n… unchanged context omitted …";
  const truncatedMarker = "\n… hunk body truncated …";
  if (useful.length + contextMarker.length <= limit) return `${useful}${contextMarker}`;
  return useful.slice(0, Math.max(0, limit - truncatedMarker.length)) + truncatedMarker.slice(0, limit);
};

/** Prompt the model for stage JSON referencing hunks by their stable ids.
 * `inputBudget` is global, model-aware, and includes all instructions.  Bodies
 * are shared across hunks rather than granting every hunk an unbounded slice. */
export function buildWalkthroughPrompt(
  files: DiffFileSummary[],
  inputBudget = DEFAULT_WALKTHROUGH_INPUT_BUDGET,
): string {
  const lines: string[] = [
    "You are producing a guided walkthrough of a code change for a reviewer.",
    "Group the hunks below into logical stages (ordered for understanding, not file order).",
    "Reply with ONLY JSON, no code fences, matching:",
    '{"stages":[{"title":"...","explanation":"...","stops":[{"hunkId":"...","explanation":"..."}]}]}',
    "Every hunkId must come from the list below. Explain intent and risk; never invent changes.",
    "",
  ];
  const hunks = files.filter((f) => !f.binary).flatMap((f) => f.hunks);
  const fixed = lines.join("\n").length;
  const labels = hunks.map((h) => `--- hunk ${h.id} (${h.path}) ${h.header}`);
  const labelLength = labels.reduce((n, label) => n + label.length + 1, 0);
  let remaining = Math.max(0, inputBudget - fixed - labelLength);
  for (const [index, hunk] of hunks.entries()) {
    const left = hunks.length - index;
    const share = Math.max(0, Math.floor(remaining / left));
    lines.push(labels[index]!);
    if (share > 0) {
      const body = compactHunk(hunk, share);
      lines.push(body);
      remaining -= body.length + 1;
    }
  }
  const prompt = lines.join("\n");
  return prompt.length <= inputBudget ? prompt : prompt.slice(0, inputBudget);
}

export type StageParse =
  | { ok: true; stages: GeneratedWalkthroughStage[] }
  | { ok: false; error: string };

/** Strict parser for the model's stage JSON. Unknown hunk ids fail; hunks the
 *  model did not claim are appended to a trailing "Remaining changes" stage so
 *  nothing in the source diff is hidden. */
export function parseGeneratedStages(raw: string, files: DiffFileSummary[]): StageParse {
  const hunksById = new Map<string, DiffHunk>();
  for (const f of files) for (const h of f.hunks) hunksById.set(h.id, h);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim());
  } catch {
    return { ok: false, error: "model returned malformed JSON" };
  }
  const stagesRaw = (parsed as { stages?: unknown })?.stages;
  if (!Array.isArray(stagesRaw) || stagesRaw.length === 0) {
    return { ok: false, error: "model JSON has no stages array" };
  }

  const claimed = new Set<string>();
  const stages: GeneratedWalkthroughStage[] = [];
  for (const [i, s] of stagesRaw.entries()) {
    const st = s as { title?: unknown; explanation?: unknown; stops?: unknown };
    if (typeof st.title !== "string" || !st.title.trim()) return { ok: false, error: `stage ${i + 1} has no title` };
    if (!Array.isArray(st.stops)) return { ok: false, error: `stage ${i + 1} has no stops array` };
    const stops: GeneratedWalkthroughStop[] = [];
    for (const stop of st.stops) {
      const sp = stop as { hunkId?: unknown; explanation?: unknown };
      const hunk = typeof sp.hunkId === "string" ? hunksById.get(sp.hunkId) : undefined;
      if (!hunk) return { ok: false, error: `unknown hunkId ${String(sp.hunkId)} in stage ${i + 1}` };
      if (claimed.has(hunk.id)) continue; // a hunk appears once, first claim wins
      claimed.add(hunk.id);
      stops.push(stopOf(hunk, typeof sp.explanation === "string" ? sp.explanation.slice(0, 4_000) : ""));
    }
    if (stops.length === 0) continue;
    stages.push({
      id: `stage-${stages.length + 1}`,
      title: st.title.trim().slice(0, 200),
      explanation: typeof st.explanation === "string" ? st.explanation.slice(0, 4_000) : "",
      stops,
    });
  }
  if (stages.length === 0) return { ok: false, error: "model JSON produced no usable stages" };

  const leftovers = [...hunksById.values()].filter((h) => !claimed.has(h.id));
  if (leftovers.length) {
    stages.push({
      id: `stage-${stages.length + 1}`,
      title: "Remaining changes",
      explanation: "Hunks the generator did not group; review directly.",
      stops: leftovers.map((h) => stopOf(h, "")),
    });
  }
  return { ok: true, stages };
}
