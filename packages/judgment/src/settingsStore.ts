import { readFileSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import type { JudgmentConfig } from "./types.ts";
import { record, safeId, boundedJson } from "./validation.ts";
import { validateUsesConfig } from "./uses.ts";

const invalid = () => Object.assign(new Error("Invalid Judgment settings"), { code: "invalid-input" });
export function validateConfig(value: unknown, partial = false): asserts value is JudgmentConfig {
  if (!record(value) || (!partial && typeof value.enabled !== "boolean")) throw invalid();
  boundedJson(value, 96_000);
  for (const [key, entry] of Object.entries(value)) {
    if (key === "enabled") { if (typeof entry !== "boolean") throw invalid(); }
    else if (["engineId", "providerId", "modelId"].includes(key)) {
      if (typeof entry !== "string" || !entry.trim() || entry.length > 200) throw invalid();
    } else if (key === "scopes") {
      if (!record(entry) || Object.keys(entry).length > 128) throw invalid();
      for (const [scope, target] of Object.entries(entry)) {
        if (!safeId(scope) || !record(target) || Object.keys(target).some((k) => !["engineId", "providerId", "modelId"].includes(k))) throw invalid();
        validateConfig(target, true);
      }
    } else if (key === "limits") {
      if (!record(entry)) throw invalid();
      const ceilings: Record<string, number> = { timeoutMs: 120_000, maxCallsPerRun: 4_096, maxConcurrentCalls: 32 };
      for (const [name, limit] of Object.entries(entry)) {
        if (!Object.hasOwn(ceilings, name) || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > ceilings[name]!) throw invalid();
      }
    } else if (key === "uses") validateUsesConfig(entry);
    else throw invalid();
  }
}
interface StoredSettings { version: 1; revision: number; global: JudgmentConfig; projects: Record<string, Partial<JudgmentConfig>> }
export function readSettings(file: string): StoredSettings {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { version: 1, revision: 0, global: { enabled: true }, projects: {} };
    throw invalid();
  }
  if (!record(raw) || raw.version !== 1 || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0 || !record(raw.projects)) throw invalid();
  validateConfig(raw.global);
  for (const [id, config] of Object.entries(raw.projects)) { if (!safeId(id)) throw invalid(); validateConfig(config, true); }
  return raw as unknown as StoredSettings;
}
export function writeSettings(file: string, config: unknown, expectedRevision: number, projectId?: string): StoredSettings {
  validateConfig(config, !!projectId);
  const current = readSettings(file);
  if (current.revision !== expectedRevision) throw Object.assign(new Error("Judgment settings changed; reload before saving"), { code: "conflict" });
  const next: StoredSettings = { ...current, revision: current.revision + 1,
    ...(projectId ? { projects: { ...current.projects, [projectId]: config } } : { global: config }) };
  atomicWriteSync(file, `${JSON.stringify(next)}\n`, 0o600);
  return next;
}
