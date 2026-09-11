import { activeBrowserAccountId } from "./accountStorage.ts";
import { isBrowserAccountScopeResolved } from "./authPrefetch.ts";
import {
  clientContextStore,
  setClientPersistenceBackend,
  type PersistenceScope,
} from "./clientPersistence.ts";

export interface ClientReliabilityContext {
  connectionScope: string;
  spaceId: string;
}

let context: ClientReliabilityContext = { connectionScope: "browser-origin", spaceId: "default" };
let activeProjectId: string | undefined;

export function setClientReliabilityContext(next: ClientReliabilityContext): void {
  if (!next.connectionScope || !next.spaceId) throw new Error("client reliability context is incomplete");
  context = { connectionScope: next.connectionScope, spaceId: next.spaceId };
}

export function setClientReliabilitySpace(spaceId: string): void {
  if (!spaceId) throw new Error("spaceId is required");
  context = { ...context, spaceId };
}

export function setClientReliabilityProject(projectId: string | null): void {
  activeProjectId = projectId ?? undefined;
}

export function clientPersistenceScope(input: { projectId?: string; sessionId?: string } = {}): PersistenceScope {
  const projectId = input.projectId ?? activeProjectId;
  return {
    connectionScope: context.connectionScope,
    accountId: activeBrowserAccountId(),
    spaceId: context.spaceId,
    ...(projectId ? { projectId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

/** Account-level records (for example restored navigation) intentionally omit
 * Space/project/session. Their value names the narrower target and is checked
 * against the authenticated server's current project/session lists on restore. */
export function clientAccountPersistenceScope(): PersistenceScope {
  return {
    connectionScope: context.connectionScope,
    accountId: activeBrowserAccountId(),
  };
}

/** Boot hook for the native loopback. It deliberately falls back to ordinary
 * origin storage when the endpoint is absent (desktop/browser). */
export async function initializeClientReliabilityContext(): Promise<ClientReliabilityContext> {
  if (!isBrowserAccountScopeResolved()) {
    // Account identity is part of the trust namespace. If its protected
    // discovery failed, use a document-ephemeral scope instead of risking
    // another account's browser/mobile recovery records.
    const nonce = typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
    setClientPersistenceBackend(null);
    setClientReliabilityContext({ connectionScope: `account-unresolved-${nonce}`, spaceId: context.spaceId });
    return context;
  }
  try {
    const response = await fetch("/__polyth/client-context");
    if (!response.ok) return context;
    const value = await response.json() as { protocolVersion?: unknown; connectionScope?: unknown };
    if (value.protocolVersion !== 1 || typeof value.connectionScope !== "string" || !value.connectionScope) return context;
    setClientReliabilityContext({ connectionScope: value.connectionScope, spaceId: context.spaceId });
    setClientPersistenceBackend(clientContextStore());
  } catch {
    // Normal direct-server/browser operation has no proxy context endpoint.
  }
  return context;
}
