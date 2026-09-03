// Global behavior instructions (WP9). The server owns the canonical revisioned
// copy under its data directory; the backend adapter is the only component
// that projects the text into backend configuration. Writes are atomic and a
// failed apply rolls the canonical copy back, so file and backend never split.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface BehaviorState {
  text: string;
  revision: string;
  pathLabel: string;
}

export interface BehaviorApplier {
  applyBehavior(text: string): Promise<number>;
  behaviorPath(): string;
}

export interface BehaviorService {
  get(): Promise<BehaviorState>;
  put(text: string, expectedRevision: string): Promise<BehaviorState>;
  subagentPolicy(): Promise<{ enabled: boolean }>;
  putSubagentPolicy(enabled: boolean): Promise<{ enabled: boolean }>;
  refresh(): Promise<void>;
  /** Current revision+digest for the model-visible instructions-applied event. */
  current(): Promise<{ revision: string; digest: string } | null>;
}

const MAX_BYTES = 256 * 1024;

export const behaviorRevision = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

export const favoriteSubagentRoutingSection = `## Favorite subagent routing (mandatory)

Before delegating work, evaluate the task and explicitly choose the best-fit agent from the user's favorites. Never spawn a subagent that merely inherits the parent or default model. If no suitable favorite is available, do the work directly. If the chosen agent stalls, errors, or returns unusable work, switch to a different favorite; do not repeatedly retry the same failed choice.`;

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export function createBehaviorService(opts: {
  file: string;
  policyFile?: string;
  applier?: BehaviorApplier;
  /** Server-owned instructions appended at apply/digest time but not exposed
   *  as editable behavior text. */
  decorate?(text: string): string;
}): BehaviorService {
  mkdirSync(dirname(opts.file), { recursive: true });

  const readText = async (): Promise<string> => {
    try {
      return await readFile(opts.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  };

  const pathLabel = opts.applier ? "global AGENTS.md" : "global AGENTS.md (backend not attached)";
  const readPolicy = async (): Promise<{ enabled: boolean }> => {
    if (!opts.policyFile) return { enabled: false };
    try {
      const value = JSON.parse(await readFile(opts.policyFile, "utf8")) as { enabled?: unknown };
      return { enabled: value.enabled !== false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { enabled: true };
      throw err;
    }
  };
  const writePolicy = async (policy: { enabled: boolean }): Promise<void> => {
    if (!opts.policyFile) return;
    await atomicWrite(opts.policyFile, `${JSON.stringify(policy, null, 2)}\n`);
  };
  const effective = async (text: string): Promise<string> => {
    const decorated = opts.decorate?.(text) ?? text;
    if (!(await readPolicy()).enabled) return decorated;
    const base = decorated.trimEnd();
    return `${base}${base ? "\n\n" : ""}${favoriteSubagentRoutingSection}\n`;
  };
  const apply = async (): Promise<void> => {
    if (opts.applier) await opts.applier.applyBehavior(await effective(await readText()));
  };

  return {
    async get(): Promise<BehaviorState> {
      const text = await readText();
      return { text, revision: behaviorRevision(text), pathLabel };
    },

    async put(text: string, expectedRevision: string): Promise<BehaviorState> {
      if (typeof text !== "string") {
        throw Object.assign(new Error("behavior text must be a string"), { code: "invalid-input" });
      }
      if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
        throw Object.assign(new Error("behavior text exceeds 256 KiB"), { code: "invalid-input" });
      }
      const before = await readText();
      const currentRev = behaviorRevision(before);
      if (expectedRevision !== currentRev) {
        throw Object.assign(new Error("behavior text changed since you loaded it"), { code: "conflict" });
      }
      await atomicWrite(opts.file, text);
      if (opts.applier) {
        try {
          await opts.applier.applyBehavior(await effective(text));
        } catch (err) {
          // Canonical copy must match what the backend actually runs with.
          await atomicWrite(opts.file, before);
          throw Object.assign(
            new Error(`backend apply failed, change rolled back: ${(err as Error).message}`),
            { code: "conflict" },
          );
        }
      }
      return { text, revision: behaviorRevision(text), pathLabel };
    },

    subagentPolicy: readPolicy,

    async putSubagentPolicy(enabled: boolean): Promise<{ enabled: boolean }> {
      const before = await readPolicy();
      const next = { enabled };
      await writePolicy(next);
      try {
        await apply();
      } catch (err) {
        await writePolicy(before);
        throw Object.assign(
          new Error(`backend apply failed, change rolled back: ${(err as Error).message}`),
          { code: "conflict" },
        );
      }
      return next;
    },

    refresh: apply,

    async current(): Promise<{ revision: string; digest: string } | null> {
      const text = await effective(await readText());
      if (!text.trim()) return null;
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      return { revision: digest.slice(0, 12), digest };
    },
  };
}
