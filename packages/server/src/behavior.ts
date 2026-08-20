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
  /** Current revision+digest for the model-visible instructions-applied event. */
  current(): Promise<{ revision: string; digest: string } | null>;
}

const MAX_BYTES = 256 * 1024;

export const behaviorRevision = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

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

export function createBehaviorService(opts: { file: string; applier?: BehaviorApplier }): BehaviorService {
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
          await opts.applier.applyBehavior(text);
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

    async current(): Promise<{ revision: string; digest: string } | null> {
      const text = await readText();
      if (!text.trim()) return null;
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      return { revision: digest.slice(0, 12), digest };
    },
  };
}
