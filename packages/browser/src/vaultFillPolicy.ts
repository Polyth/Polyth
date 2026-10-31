import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SpaceStorage } from "@polyth/contracts";
import type { BrowserVaultFillRequest } from "./vaultFill.ts";

const POLICY_FILE = "vault-fill-approvals.json";
const POLICY_VERSION = 1;
const MAX_APPROVALS = 256;

export interface BrowserVaultFillApproval {
  spaceId: string;
  projectId: string;
  handle: string;
  origin: string;
  grantedAt: number;
}

interface StoredPolicy {
  version: 1;
  approvals: BrowserVaultFillApproval[];
}

const policyPath = (storage: SpaceStorage): string =>
  join(storage.packageDir("browser"), POLICY_FILE);

function validApproval(value: unknown): value is BrowserVaultFillApproval {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<BrowserVaultFillApproval>;
  return typeof row.spaceId === "string" && row.spaceId.length > 0
    && typeof row.projectId === "string" && row.projectId.length > 0
    && typeof row.handle === "string" && row.handle.length > 0
    && typeof row.origin === "string" && row.origin.length > 0
    && typeof row.grantedAt === "number" && Number.isFinite(row.grantedAt);
}

async function readPolicy(storage: SpaceStorage): Promise<BrowserVaultFillApproval[]> {
  try {
    const parsed = JSON.parse(await readFile(policyPath(storage), "utf8")) as Partial<StoredPolicy>;
    if (parsed.version !== POLICY_VERSION || !Array.isArray(parsed.approvals)) return [];
    return parsed.approvals.filter(validApproval).slice(-MAX_APPROVALS).map((row) => ({
      ...row,
      origin: row.origin.toLocaleLowerCase(),
    }));
  } catch {
    return [];
  }
}

async function writePolicy(storage: SpaceStorage, approvals: BrowserVaultFillApproval[]): Promise<void> {
  const dir = storage.packageDir("browser");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = policyPath(storage);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const payload: StoredPolicy = {
    version: POLICY_VERSION,
    approvals: approvals.slice(-MAX_APPROVALS),
  };
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

const sameGrant = (
  row: BrowserVaultFillApproval,
  request: Pick<BrowserVaultFillRequest, "spaceId" | "projectId" | "handle" | "origin">,
): boolean => row.spaceId === request.spaceId
  && row.projectId === request.projectId
  && row.handle.toLocaleLowerCase() === request.handle.toLocaleLowerCase()
  && row.origin === request.origin.toLocaleLowerCase();

export async function readBrowserVaultFillApprovals(
  storage: SpaceStorage,
): Promise<BrowserVaultFillApproval[]> {
  return (await readPolicy(storage)).map((row) => ({ ...row }));
}

export async function isBrowserVaultFillAllowed(
  storage: SpaceStorage,
  request: Pick<BrowserVaultFillRequest, "spaceId" | "projectId" | "handle" | "origin">,
): Promise<boolean> {
  if (!request.spaceId) return false;
  return (await readPolicy(storage)).some((row) => sameGrant(row, request));
}

export async function allowBrowserVaultFill(
  storage: SpaceStorage,
  request: Pick<BrowserVaultFillRequest, "spaceId" | "projectId" | "handle" | "origin">,
): Promise<void> {
  if (!request.spaceId) throw Object.assign(new Error("Credential approval requires a Space"), { code: "invalid-input" });
  const approvals = await readPolicy(storage);
  if (approvals.some((row) => sameGrant(row, request))) return;
  approvals.push({
    spaceId: request.spaceId,
    projectId: request.projectId,
    handle: request.handle,
    origin: request.origin.toLocaleLowerCase(),
    grantedAt: Date.now(),
  });
  await writePolicy(storage, approvals);
}

export async function clearBrowserVaultFillApprovals(storage: SpaceStorage): Promise<void> {
  await writePolicy(storage, []);
}
