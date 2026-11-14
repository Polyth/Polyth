// Per-person policy file under the Space's package directory. Writes to one
// file are serialized so two PUTs cannot interleave; the revision check runs
// inside that section.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import { DEFAULT_POLICY, type RoutingPolicy, type StoredRoutingPolicy } from "./contracts.ts";
import { normalizeStoredPolicy, parsePolicy, policyRevision } from "./policy.ts";

const conflict = () => Object.assign(new Error("The policy changed elsewhere; reload before saving"), { code: "conflict" });

export const personFile = (packageDir: string, userId: string): string =>
  join(packageDir, "people", `${createHash("sha256").update(userId).digest("hex").slice(0, 32)}.json`);

const defaults = (): StoredRoutingPolicy => ({ ...normalizeStoredPolicy(DEFAULT_POLICY), revision: "default" });

export interface ReadResult { policy: StoredRoutingPolicy; corrupt: boolean }

export function readPolicyFile(file: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { policy: defaults(), corrupt: false };
    return { policy: defaults(), corrupt: true };
  }
  try {
    const raw = JSON.parse(text) as { policy?: unknown; updatedAt?: unknown };
    const policy = normalizeStoredPolicy(raw?.policy);
    return {
      policy: {
        ...policy,
        revision: policyRevision(policy),
        ...(typeof raw?.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
      },
      corrupt: false,
    };
  } catch {
    return { policy: defaults(), corrupt: true };
  }
}

const chains = new Map<string, Promise<unknown>>();

/** Run `task` after every earlier task on the same file. */
function serialized<T>(file: string, task: () => T): Promise<T> {
  const previous = chains.get(file) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.catch(() => undefined);
  chains.set(file, tail);
  void tail.then(() => { if (chains.get(file) === tail) chains.delete(file); });
  return next;
}

export function savePolicy(file: string, input: unknown, expectedRevision: unknown, now = Date.now()): Promise<StoredRoutingPolicy> {
  const policy: RoutingPolicy = parsePolicy(input);
  if (typeof expectedRevision !== "string") {
    return Promise.reject(Object.assign(new Error("expectedRevision must be a string"), { code: "invalid-input" }));
  }
  return serialized(file, () => {
    if (readPolicyFile(file).policy.revision !== expectedRevision) throw conflict();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteSync(file, `${JSON.stringify({ version: 1, updatedAt: now, policy })}\n`, 0o600);
    return { ...policy, revision: policyRevision(policy), updatedAt: now };
  });
}

export function resetPolicy(file: string): Promise<StoredRoutingPolicy> {
  return serialized(file, () => {
    rmSync(file, { force: true });
    return defaults();
  });
}
