import { randomBytes } from "node:crypto";

const TTL_MS = 10 * 60 * 1000;

export interface OauthTx {
  oauthTxId: string;
  spaceId: string;
  packageId: string;
  version: string;
  integrity: string;
  installGeneration: string;
  connectionId: string;
  connectionFingerprint: string;
  redirectUri: string;
  verifier: string;
  expiry: number;
}

const txs = new Map<string, OauthTx>();
const liveByConnection = new Map<string, string>();

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function connectionKey(tx: Pick<OauthTx, "spaceId" | "packageId" | "connectionId">): string {
  return `${tx.spaceId}:${tx.packageId}:${tx.connectionId}`;
}

function prune(now = Date.now()): void {
  for (const [id, tx] of txs) {
    if (tx.expiry <= now) {
      txs.delete(id);
      const key = connectionKey(tx);
      if (liveByConnection.get(key) === id) liveByConnection.delete(key);
    }
  }
}

export function createOauthTx(input: Omit<OauthTx, "oauthTxId" | "expiry">): OauthTx {
  prune();
  const key = connectionKey(input);
  const previous = liveByConnection.get(key);
  if (previous) txs.delete(previous);
  const oauthTxId = randomBytes(24).toString("hex");
  const tx: OauthTx = {
    ...input,
    oauthTxId,
    expiry: Date.now() + TTL_MS,
  };
  txs.set(oauthTxId, tx);
  liveByConnection.set(key, oauthTxId);
  return tx;
}

export function consumeOauthTx(input: {
  oauthTxId: string;
  spaceId: string;
}): OauthTx {
  prune();
  const tx = txs.get(input.oauthTxId);
  if (!tx) return fail("invalid-input", "oauth callback is invalid");
  if (tx.expiry <= Date.now()) {
    txs.delete(tx.oauthTxId);
    return fail("invalid-input", "oauth callback expired");
  }
  if (tx.spaceId !== input.spaceId) return fail("invalid-input", "oauth callback is invalid");
  txs.delete(tx.oauthTxId);
  const key = connectionKey(tx);
  if (liveByConnection.get(key) === tx.oauthTxId) liveByConnection.delete(key);
  return tx;
}

/** Redirect origin for OAuth. Never trust forwarded Host/Proto headers. */
export function oauthRedirectOrigin(input: {
  hostHeader?: string | string[];
  configured?: string;
}): string {
  const configured = input.configured?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return fail("invalid-input", "POLYTH_PUBLIC_ORIGIN is invalid");
      }
      if (url.username || url.password) {
        return fail("invalid-input", "POLYTH_PUBLIC_ORIGIN is invalid");
      }
      return url.origin;
    } catch {
      return fail("invalid-input", "POLYTH_PUBLIC_ORIGIN is invalid");
    }
  }
  const raw = Array.isArray(input.hostHeader) ? input.hostHeader[0] : input.hostHeader;
  const host = (raw ?? "").split(",")[0]!.trim();
  if (!host || /[\s/@\\]/.test(host)) {
    return fail("invalid-input", "oauth redirect origin is unavailable");
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return fail("invalid-input", "oauth redirect origin is unavailable");
  }
  if (parsed.username || parsed.password) {
    return fail("invalid-input", "oauth redirect origin is unavailable");
  }
  const hostname = parsed.hostname;
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
    return fail("invalid-input", "oauth redirect origin is not a local host");
  }
  return parsed.origin;
}

export function assertOauthTxMatchesActive(tx: OauthTx, active: {
  packageId: string;
  version: string;
  integrity: string;
  installGeneration: string;
  connectionId: string;
  connectionFingerprint: string;
}): void {
  if (
    tx.packageId !== active.packageId
    || tx.version !== active.version
    || tx.integrity !== active.integrity
    || tx.installGeneration !== active.installGeneration
    || tx.connectionId !== active.connectionId
    || tx.connectionFingerprint !== active.connectionFingerprint
  ) {
    fail("invalid-input", "oauth retry required; package changed during authorization");
  }
}
