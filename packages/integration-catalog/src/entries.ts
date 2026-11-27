// Reading the catalog from disk. Server-only: the browser never sees the
// filesystem, it receives the validated list from the route in `serverEntry.ts`.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateCatalog,
  validateManifest,
  type IntegrationManifest,
} from "./manifest.ts";

/** `packages/integration-catalog/catalog` — one folder per entry. */
export const CATALOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "catalog");

export const MANIFEST_FILE = "integration.json";

export interface CatalogLoad {
  entries: IntegrationManifest[];
  /** Every reason something could not ship. Empty for a healthy catalog. A
   *  broken manifest is reported next to the rest instead of hiding the page:
   *  the page is how a person sees that something is wrong. */
  problems: string[];
}

/**
 * Read every `catalog/<id>/integration.json`, validate it and sort by id.
 * A folder without a manifest is reported, not skipped silently.
 */
export async function loadCatalog(directory: string = CATALOG_DIR): Promise<CatalogLoad> {
  const problems: string[] = [];
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    return { entries: [], problems: [`catalog directory is unreadable: ${(cause as Error).message}`] };
  }

  const entries: IntegrationManifest[] = [];
  for (const id of names) {
    const file = join(directory, id, MANIFEST_FILE);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      problems.push(`${id}: no ${MANIFEST_FILE}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      problems.push(`${id}: invalid JSON (${(cause as Error).message})`);
      continue;
    }
    const errors = validateManifest(parsed, id);
    if (errors.length > 0) {
      problems.push(...errors.map((error) => `${id}: ${error}`));
      continue;
    }
    const manifest = parsed as IntegrationManifest;
    if (manifest.agentSkill) {
      // A skill Connect would fail to read is a broken entry, found here
      // rather than on someone's click.
      const skill = await readAgentSkill(manifest, directory);
      if (!skill.ok) {
        problems.push(`${id}: ${skill.problem}`);
        continue;
      }
    }
    entries.push(manifest);
  }

  problems.push(...validateCatalog(entries));
  return { entries, problems };
}

/** Longest instructions an entry may ship; a skill is guidance, not a manual. */
export const MAX_AGENT_SKILL_BYTES = 16_000;

/** The instructions of an entry's `agentSkill`, read from its folder. */
export async function readAgentSkill(
  entry: IntegrationManifest,
  directory: string = CATALOG_DIR,
): Promise<{ ok: true; instructions: string } | { ok: false; problem: string }> {
  const skill = entry.agentSkill;
  if (!skill) return { ok: false, problem: "no agentSkill" };
  let text: string;
  try {
    text = await readFile(join(directory, entry.id, skill.file), "utf8");
  } catch {
    return { ok: false, problem: `agentSkill.file ${skill.file} is missing` };
  }
  if (!text.trim()) return { ok: false, problem: `agentSkill.file ${skill.file} is empty` };
  if (Buffer.byteLength(text) > MAX_AGENT_SKILL_BYTES) {
    return { ok: false, problem: `agentSkill.file ${skill.file} is over ${MAX_AGENT_SKILL_BYTES} bytes` };
  }
  return { ok: true, instructions: text.trim() };
}
