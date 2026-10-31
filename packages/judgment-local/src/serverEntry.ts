import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { JudgmentExecutionError } from "@polyth/judgment";
import { JUDGMENT_SERVICE, type JudgmentServerContext } from "@polyth/judgment/server";
import type { SpaceContext } from "@polyth/contracts";
import { createLocalJudgmentEngine, LOCAL_ENGINE_METADATA, LOCAL_PROVIDER, startLocalRunner, type LocalModelRunner } from "./engine.ts";

interface Pinned { path: string; sha256: string }
/** TheREZOR/TinyDecide at a pinned revision. The SHA-256 of every byte is the integrity boundary, not the host. */
const ORIGIN = "https://huggingface.co/TheREZOR/TinyDecide/resolve/5e0481b814f5158ae799b92d7427f211b7739c98/";
const ENGINE: Pinned = { path: "tinydecide.js", sha256: "21b4d37f9a304bae92ffe9f460bc7f71d1b4941d7a84f52d7dee0ee13fe40971" };
export const LOCAL_PRESETS: Readonly<Record<string, { name: string; meta: Pinned; weights: Pinned }>> = {
  tinydecide: { name: "TinyDecide (6 MB)",
    meta: { path: "meta.json", sha256: "2fb895cfb0cdd6b11fcfb5573033e846bf4defadb3c78b9989cccfeefe06758f" },
    weights: { path: "model.bin", sha256: "23fe9d93f2eafadbe4dc686a7dc5f309fbcba9ea1a4873d457e75d17c5bf3441" } },
  "tinydecide-full": { name: "TinyDecide full (10 MB)",
    meta: { path: "full/meta.json", sha256: "75e43116278c670255685522cec392ea45c9931443513f6b14c2c16d000676bd" },
    weights: { path: "full/model.bin", sha256: "dcf52490b0505e0cd798713117f448a499ecb142db31fffcdd63e97f79f78d5a" } },
};
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_FILE = { engine: 1 << 20, meta: 4 << 20, weights: 64 << 20 };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const regularFile = (path: string) => { try { return lstatSync(path).isFile(); } catch { return false; } };
const arrayBuffer = (bytes: Buffer) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const settle = <T,>(promise: Promise<T>, signal: AbortSignal) => new Promise<T>((resolve, reject) => {
  if (signal.aborted) return reject(new JudgmentExecutionError("cancelled"));
  const abort = () => reject(new JudgmentExecutionError("cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
});

async function readBounded(path: string, max: number): Promise<Buffer> {
  // Symlinks are refused: a model folder must not reach outside Space storage.
  if (!regularFile(path) || lstatSync(path).size > max) throw new JudgmentExecutionError("model-unavailable");
  return readFile(path);
}
/** The verified local copy, else one download. A wrong hash is never used or kept. */
async function pinned(path: string, file: Pinned, max: number, signal: AbortSignal): Promise<Buffer> {
  const local = await readBounded(path, max).catch(() => undefined);
  if (local && sha256(local) === file.sha256) return local;
  let bytes: Buffer;
  try {
    const response = await fetch(ORIGIN + file.path, { signal });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > max) throw new JudgmentExecutionError("model-unavailable");
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) { throw error instanceof JudgmentExecutionError ? error : new JudgmentExecutionError("provider-error", true); }
  if (bytes.byteLength > max || sha256(bytes) !== file.sha256) throw new JudgmentExecutionError("model-unavailable");
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}.partial`;
  try { await writeFile(partial, bytes, { mode: 0o644 }); await rename(partial, path); }
  finally { await rm(partial, { force: true }); }
  return bytes;
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let unregister: (() => void) | undefined;
  let lifetime = new AbortController();
  const runners = new Map<string, Promise<LocalModelRunner>>();
  const root = (space: SpaceContext) => host.spaceStorage(space).packageDir("judgment-local");
  /** User models: `<root>/models/<id>/{meta.json,model.bin}` in TinyDecide format. Presets live apart and win on a name clash. */
  const customModels = (space: SpaceContext) => {
    try {
      const dir = join(root(space), "models");
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && MODEL_ID.test(entry.name) && !Object.hasOwn(LOCAL_PRESETS, entry.name)
          && regularFile(join(dir, entry.name, "meta.json")) && regularFile(join(dir, entry.name, "model.bin")))
        .map((entry) => entry.name).sort();
    } catch { return []; }
  };
  const models = (space: SpaceContext) => [...Object.keys(LOCAL_PRESETS), ...customModels(space)];
  const load = async (space: SpaceContext, modelId: string, onExit: () => void): Promise<LocalModelRunner> => {
    const base = root(space), preset = LOCAL_PRESETS[modelId];
    // A preset installs on first use; the download is bounded by its own deadline, not by one request's.
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120_000)]);
    const engine = await pinned(join(base, "engine", ENGINE.path), ENGINE, MAX_FILE.engine, signal);
    const dir = join(base, preset ? "presets" : "models", modelId);
    const [meta, weights] = preset
      ? await Promise.all([pinned(join(dir, "meta.json"), preset.meta, MAX_FILE.meta, signal), pinned(join(dir, "model.bin"), preset.weights, MAX_FILE.weights, signal)])
      : await Promise.all([readBounded(join(dir, "meta.json"), MAX_FILE.meta), readBounded(join(dir, "model.bin"), MAX_FILE.weights)]);
    let parsed: unknown;
    try { parsed = JSON.parse(meta.toString("utf8")); } catch { throw new JudgmentExecutionError("model-unavailable"); }
    if (lifetime.signal.aborted) throw new JudgmentExecutionError("engine-unavailable");
    return startLocalRunner({ engineSource: engine.toString("utf8"), meta: parsed, weights: arrayBuffer(weights) }, onExit);
  };
  const runner = (ctx: JudgmentServerContext, modelId: string, signal: AbortSignal) => {
    const key = JSON.stringify([ctx.space.spaceId, modelId]);
    let entry = runners.get(key);
    if (!entry) {
      const forget = () => { if (runners.get(key) === entry) runners.delete(key); };
      entry = load(ctx.space, modelId, forget);
      entry.catch(forget);
      runners.set(key, entry);
    }
    return settle(entry, signal);
  };
  return {
    remoteAccess: localOnlyRemoteAccess(["judgment-local"]),
    onEnable() {
      if (unregister) return;
      const judgment = host.services.get(JUDGMENT_SERVICE);
      if (!judgment) return;
      lifetime = new AbortController();
      unregister = judgment.registerEngine({
        metadata: LOCAL_ENGINE_METADATA,
        create: (ctx) => createLocalJudgmentEngine({ models: () => models(ctx.space), runner: (modelId, signal) => runner(ctx, modelId, signal) }),
        catalog(ctx) {
          const custom = customModels(ctx.space);
          return [{ provider: { ...LOCAL_PROVIDER }, status: "available", credential: "none", automatic: true, local: true,
            description: `Runs on this server; evidence never leaves it. TinyDecide downloads once, verified, on first use. Add your own TinyDecide-format models as ${join(root(ctx.space), "models", "<name>")}/{meta.json,model.bin}.`,
            models: [...Object.entries(LOCAL_PRESETS).map(([modelID, preset]) => ({ modelID, name: preset.name })), ...custom.map((modelID) => ({ modelID, name: modelID }))]
              .map((model) => ({ ...model, providerID: LOCAL_PROVIDER.id, providerName: LOCAL_PROVIDER.name, connected: true, capabilities: ["input:text"] })) }];
        },
      });
    },
    onDisable() {
      unregister?.(); unregister = undefined;
      lifetime.abort();
      for (const entry of runners.values()) void entry.then((loaded) => loaded.close(), () => {});
      runners.clear();
    },
  };
}
