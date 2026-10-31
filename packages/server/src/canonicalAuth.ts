import type { ControlPlane } from "@polyth/control-plane";
import type { IdentityService, IdentitySession } from "@polyth/identity";
import type { AccountGuardrails, AuthPrincipal, AuthResolution, RequestIngress } from "@polyth/contracts";
import { bearerToken, isCommandLineRequest, isPrivateNetworkAddress, type AuthRequestLike, type GateDenial, type PairedDeviceResolver } from "./auth.ts";

type IdentifiedPrincipal = AuthPrincipal & { userId?: string };
const ANONYMOUS: AuthPrincipal = { kind: "anonymous" };
const DEBUG_AGENT_SESSION_ID = "debug-agent";
/** `local-user` session id of the owner-enabled no-token command line. */
export const TRUSTED_CLI_SESSION_ID = "trusted-cli";

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
  /** Current owner-set guardrails of an account; null = unrestricted. Read
   *  live on every resolution so a change applies to the next request/frame. */
  guardrailsFor(userId: string): AccountGuardrails | null;
  cookieName(): string;
}

/**
 * Adapter from the account-first control authority into the existing HTTP/WS
 * principal contract. Direct loopback remains reachability-only unless the
 * operator explicitly enables the development-only local agent mode.
 */
export function createCanonicalAuthGateway(options: {
  control: ControlPlane;
  identity: IdentityService;
  cookieName: string;
  /** Explicitly enabled only by the validated canonical bootstrap. */
  debugAgentAccess?: boolean;
  resolvePairedDevice?: PairedDeviceResolver;
}): CanonicalAuthGateway {
  const debugAgentAccess = options.debugAgentAccess === true;
  let pairedResolver = options.resolvePairedDevice;
  const accountExists = (userId: string): boolean => !!options.control.get(
    "SELECT 1 FROM users u JOIN principals p ON p.id=u.id WHERE u.id=? AND p.kind='user' AND p.status='active'",
    userId,
  );
  const guardrailsFor = (userId: string): AccountGuardrails | null =>
    (options.identity.guardrails.forUser(userId).guardrails as AccountGuardrails | null) ?? null;
  /** Attach (or drop) the account ceiling; never trust one already present. */
  const withCeiling = <P extends Extract<AuthPrincipal, { kind: "ui-session" | "paired-device" }>>(principal: P, userId: string): P => {
    const { accountGrants: _stale, ...rest } = principal;
    const guardrails = guardrailsFor(userId);
    return (guardrails ? { ...rest, accountGrants: Object.freeze([...guardrails.grants]) } : rest) as P;
  };
  const directUser = (principal: AuthPrincipal): string | undefined => {
    const value = (principal as IdentifiedPrincipal).userId;
    return typeof value === "string" && value ? value : undefined;
  };
  const activeOwnerId = (): string | undefined => options.control.get<{ user_id: string }>(
    `SELECT r.user_id FROM instance_roles r JOIN principals p ON p.id=r.user_id
      WHERE r.role='owner' AND p.status='active' ORDER BY r.user_id LIMIT 1`,
  )?.user_id;
  const debugOwnerPrincipal = (): AuthPrincipal | null => {
    if (!debugAgentAccess) return null;
    const userId = activeOwnerId();
    return userId
      ? ({
          kind: "local-user",
          sessionId: DEBUG_AGENT_SESSION_ID,
          trustedLoopback: true,
          userId,
        } as AuthPrincipal)
      : null;
  };
  const livePair = (principal: Extract<AuthPrincipal, { kind: "paired-device" }>): AuthPrincipal | null => {
    const userId = directUser(principal);
    if (!userId || !accountExists(userId) || !pairedResolver) return null;
    const latest = pairedResolver({ kind: "polyth-link", connectionId: principal.connectionId, transport: principal.transport });
    if (!latest || latest.kind !== "paired-device" || latest.connectionId !== principal.connectionId
      || latest.deviceId !== principal.deviceId || directUser(latest) !== userId) return null;
    return withCeiling(latest, userId);
  };
  const tokenPrincipal = (token: ReturnType<IdentityService["accessTokens"]["resolve"]>): AuthPrincipal | null => {
    if (!token) return null;
    const principal = {
      kind: "access-token",
      tokenId: token.id,
      tokenKind: token.kind,
      grants: Object.freeze([...token.grants]),
      ...(token.spaceId ? { spaceId: token.spaceId } : {}),
      userId: token.userId,
    } as Extract<AuthPrincipal, { kind: "access-token" }>;
    return withTokenCeiling(principal, token.userId);
  };
  const withTokenCeiling = (principal: Extract<AuthPrincipal, { kind: "access-token" }>, userId: string): AuthPrincipal => {
    const { accountGrants: _stale, ...rest } = principal;
    const guardrails = guardrailsFor(userId);
    return (guardrails ? { ...rest, accountGrants: Object.freeze([...guardrails.grants]) } : rest) as AuthPrincipal;
  };
  /** Owner-enabled no-token command line. Never for a browser, never through
   *  a proxy, and only from the network scope the owner chose. */
  const trustedCliPrincipal = (
    request: AuthRequestLike,
    ingress: Extract<RequestIngress, { kind: "public-http" }>,
  ): AuthPrincipal | null => {
    if (!isCommandLineRequest(request) || ingress.proxied === true) return null;
    const trust = options.identity.accessTokens.trust.effective();
    if (!trust) return null;
    const reachable = ingress.loopback
      || (trust.mode === "private-network" && isPrivateNetworkAddress(request.socket.remoteAddress));
    if (!reachable) return null;
    return { kind: "local-user", sessionId: TRUSTED_CLI_SESSION_ID, trustedLoopback: true, userId: trust.userId } as AuthPrincipal;
  };
  const resolvePublic = (
    request: AuthRequestLike,
    ingress: Extract<RequestIngress, { kind: "public-http" }>,
  ): AuthResolution => {
    const bearer = bearerToken(request);
    if (bearer !== null) {
      // A presented bearer token is the whole credential: an invalid one is
      // anonymous, never a fallback to cookies or local trust. Tokens travel
      // only over TLS (direct or via a trusted proxy) or loopback.
      if (!ingress.secure && !ingress.loopback) return { principal: ANONYMOUS, authenticated: false };
      const principal = tokenPrincipal(options.identity.accessTokens.resolve(bearer));
      return principal ? { principal, authenticated: true } : { principal: ANONYMOUS, authenticated: false };
    }
    const trusted = trustedCliPrincipal(request, ingress);
    if (trusted) return { principal: trusted, authenticated: true };
    const token = cookieToken(request.headers.cookie, options.cookieName);
    const session = options.identity.sessions.resolve(token);
    if (session) return { principal: withCeiling(principalForSession(session) as Extract<AuthPrincipal, { kind: "ui-session" }>, session.userId), authenticated: true };
    const debugPrincipal = ingress.loopback ? debugOwnerPrincipal() : null;
    return debugPrincipal
      ? { principal: debugPrincipal, authenticated: true }
      : { principal: ANONYMOUS, authenticated: false };
  };
  const gateway: CanonicalAuthGateway = {
    cookieName: () => options.cookieName,
    attachPairedDeviceResolver(resolver) { pairedResolver = resolver; },
    accountExists,
    guardrailsFor,
    userIdForPrincipal: directUser,
    resolve(request, ingress) {
      if (ingress.kind === "public-http") return resolvePublic(request, ingress);
      if (ingress.kind === "internal") {
        return { principal: { kind: "internal-service", serviceId: ingress.serviceId }, authenticated: true };
      }
      const paired = pairedResolver?.(ingress) ?? null;
      if (!paired || paired.kind !== "paired-device" || paired.connectionId !== ingress.connectionId) {
        return { principal: ANONYMOUS, authenticated: false };
      }
      const userId = directUser(paired);
      if (!userId || !accountExists(userId)) return { principal: ANONYMOUS, authenticated: false };
      return { principal: withCeiling(paired, userId), authenticated: true };
    },
    gate(request, ingress) {
      if (gateway.resolve(request, ingress).authenticated) return null;
      return { status: 401, body: { error: "unauthorized", message: "authentication required" } };
    },
    refreshPrincipal(principal) {
      switch (principal.kind) {
        case "anonymous":
          return null;
        case "local-user": {
          const userId = directUser(principal);
          if (principal.sessionId === TRUSTED_CLI_SESSION_ID) {
            const trust = options.identity.accessTokens.trust.effective();
            return trust && userId === trust.userId ? principal : null;
          }
          return debugAgentAccess
            && principal.sessionId === DEBUG_AGENT_SESSION_ID
            && userId
            && activeOwnerId() === userId
            ? principal
            : null;
        }
        case "internal-service":
          return principal;
        case "paired-device":
          return livePair(principal);
        case "access-token": {
          const userId = directUser(principal);
          if (!userId) return null;
          const live = options.identity.accessTokens.live(principal.tokenId, userId);
          return live ? tokenPrincipal(live) : null;
        }
        case "ui-session": {
          const userId = directUser(principal);
          if (!userId) return null;
          const live = options.identity.sessions.resolveId(principal.sessionId, userId);
          return live ? withCeiling(principalForSession(live) as Extract<AuthPrincipal, { kind: "ui-session" }>, live.userId) : null;
        }
      }
    },
  };
  return gateway;
}
