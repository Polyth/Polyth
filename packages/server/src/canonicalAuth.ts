import type { ControlPlane } from "@polyth/control-plane";
import type { IdentityService, IdentitySession } from "@polyth/identity";
import type { AuthPrincipal, AuthResolution, RequestIngress } from "@polyth/contracts";
import type { AuthRequestLike, GateDenial, PairedDeviceResolver } from "./auth.ts";

type IdentifiedPrincipal = AuthPrincipal & { userId?: string };
const ANONYMOUS: AuthPrincipal = { kind: "anonymous" };

const cookieToken = (header: string | undefined, name: string): string | null => {
  if (!header || header.length > 16_384) return null;
  const values: string[] = [];
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1 || part.slice(0, at).trim() !== name) continue;
    values.push(part.slice(at + 1).trim());
  }
  if (values.length !== 1 || !/^[a-f0-9]{64}$/.test(values[0]!)) return null;
  return values[0]!;
};

const principalForSession = (session: IdentitySession): AuthPrincipal => ({
  kind: "ui-session",
  sessionId: session.id,
  rememberedDeviceId: session.id,
  userId: session.userId,
} as AuthPrincipal);

export interface CanonicalAuthGateway {
  resolve(request: AuthRequestLike, ingress: RequestIngress): AuthResolution;
  gate(request: AuthRequestLike, ingress: RequestIngress): GateDenial | null;
  refreshPrincipal(principal: AuthPrincipal): AuthPrincipal | null;
  attachPairedDeviceResolver(resolver: PairedDeviceResolver): void;
  userIdForPrincipal(principal: AuthPrincipal): string | undefined;
  accountExists(userId: string): boolean;
  cookieName(): string;
}

/**
 * Adapter from the account-first control authority into the existing HTTP/WS
 * principal contract. Loopback address is reachability information only: it
 * never manufactures a human identity or bypasses the session cookie.
 */
export function createCanonicalAuthGateway(options: {
  control: ControlPlane;
  identity: IdentityService;
  cookieName: string;
  resolvePairedDevice?: PairedDeviceResolver;
}): CanonicalAuthGateway {
  let pairedResolver = options.resolvePairedDevice;
  const accountExists = (userId: string): boolean => !!options.control.get(
    "SELECT 1 FROM users u JOIN principals p ON p.id=u.id WHERE u.id=? AND p.kind='user' AND p.status='active'",
    userId,
  );
  const directUser = (principal: AuthPrincipal): string | undefined => {
    const value = (principal as IdentifiedPrincipal).userId;
    return typeof value === "string" && value ? value : undefined;
  };
  const livePair = (principal: Extract<AuthPrincipal, { kind: "paired-device" }>): AuthPrincipal | null => {
    const userId = directUser(principal);
    if (!userId || !accountExists(userId) || !pairedResolver) return null;
    const latest = pairedResolver({ kind: "polyth-link", connectionId: principal.connectionId, transport: principal.transport });
    if (!latest || latest.kind !== "paired-device" || latest.connectionId !== principal.connectionId
      || latest.deviceId !== principal.deviceId || directUser(latest) !== userId) return null;
    return latest;
  };
  const resolvePublic = (request: AuthRequestLike): AuthResolution => {
    const token = cookieToken(request.headers.cookie, options.cookieName);
    const session = options.identity.sessions.resolve(token);
    return session
      ? { principal: principalForSession(session), authenticated: true }
      : { principal: ANONYMOUS, authenticated: false };
  };
  const gateway: CanonicalAuthGateway = {
    cookieName: () => options.cookieName,
    attachPairedDeviceResolver(resolver) { pairedResolver = resolver; },
    accountExists,
    userIdForPrincipal: directUser,
    resolve(request, ingress) {
      if (ingress.kind === "public-http") return resolvePublic(request);
      if (ingress.kind === "internal") {
        return { principal: { kind: "internal-service", serviceId: ingress.serviceId }, authenticated: true };
      }
      const paired = pairedResolver?.(ingress) ?? null;
      if (!paired || paired.kind !== "paired-device" || paired.connectionId !== ingress.connectionId) {
        return { principal: ANONYMOUS, authenticated: false };
      }
      const userId = directUser(paired);
      if (!userId || !accountExists(userId)) return { principal: ANONYMOUS, authenticated: false };
      return { principal: paired, authenticated: true };
    },
    gate(request, ingress) {
      if (gateway.resolve(request, ingress).authenticated) return null;
      return { status: 401, body: { error: "unauthorized", message: "authentication required" } };
    },
    refreshPrincipal(principal) {
      switch (principal.kind) {
        case "anonymous":
        case "local-user":
          return null;
        case "internal-service":
          return principal;
        case "paired-device":
          return livePair(principal);
        case "ui-session": {
          const userId = directUser(principal);
          if (!userId) return null;
          const live = options.identity.sessions.resolveId(principal.sessionId, userId);
          return live ? principalForSession(live) : null;
        }
      }
    },
  };
  return gateway;
}
