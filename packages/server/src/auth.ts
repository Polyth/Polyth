// Access control: optional UI password gating /api + /ws. Sessions are
// remembered devices — an httpOnly cookie holds a random token whose SHA-256
// lives in data/auth.json, so a leaked file never yields a usable credential.
// Password hashing is crypto.scrypt (no novel crypto), login is rate-limited
// per client IP, and everything is OFF unless a password is set.
//
// Canonical API is ingress-aware `resolve()`. Loopback optional never applies
// to Polyth Link ingress, even when the tunnel physically connects via 127.0.0.1.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AuthPrincipal,
  AuthResolution,
  AuthStatusDto,
  RequestIngress,
} from "@polyth/contracts";

// ---- password hashing (scrypt, self-describing storage format) -------------

/** `scrypt$<saltHex>$<hashHex>` — verifiable without extra metadata. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1]!, "hex");
    const want = Buffer.from(parts[2]!, "hex");
    const got = scryptSync(password, salt, want.length);
    return want.length > 0 && timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

// ---- login rate limiter (pure, clock-injected) ------------------------------

export interface RateLimiterOptions {
  /** Failures inside the window before the key locks (default 10). */
  maxAttempts?: number;
  /** Sliding failure window in ms (default 10 minutes). */
  windowMs?: number;
  /** Lockout duration once tripped, in ms (default 15 minutes). */
  lockoutMs?: number;
  now?: () => number;
}

export type RateCheck = { allowed: true } | { allowed: false; retryAfterSec: number };

export interface LoginRateLimiter {
  check(key: string): RateCheck;
  fail(key: string): void;
  succeed(key: string): void;
}

export function createLoginRateLimiter(opts: RateLimiterOptions = {}): LoginRateLimiter {
  const max = opts.maxAttempts ?? 10;
  const windowMs = opts.windowMs ?? 10 * 60_000;
  const lockoutMs = opts.lockoutMs ?? 15 * 60_000;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { failures: number[]; lockedUntil: number }>();

  return {
    check(key) {
      const b = buckets.get(key);
      if (!b) return { allowed: true };
      const t = now();
      if (b.lockedUntil > t) return { allowed: false, retryAfterSec: Math.ceil((b.lockedUntil - t) / 1000) };
      return { allowed: true };
    },
    fail(key) {
      const t = now();
      const b = buckets.get(key) ?? { failures: [], lockedUntil: 0 };
      b.failures = b.failures.filter((ts) => t - ts < windowMs);
      b.failures.push(t);
      if (b.failures.length >= max) {
        b.lockedUntil = t + lockoutMs;
        b.failures = [];
      }
      buckets.set(key, b);
    },
    succeed(key) {
      buckets.delete(key);
    },
  };
}

/** Unidentified clients (no socket address) share one budget instead of each
 *  getting a fresh window. */
export const rateKeyFor = (remoteAddr: string | undefined): string => remoteAddr || "anon";

// ---- auth service ------------------------------------------------------------

/** The subset of IncomingMessage the resolver reads — fully fakeable in tests. */
export interface AuthRequestLike {
  headers: { cookie?: string; "user-agent"?: string };
  socket: { remoteAddress?: string };
}

export interface AuthDeviceDto {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  label: string;
  current: boolean;
}

export type GateDenial = { status: number; body: { error: string; message: string } };

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; status: number; error: string; message: string; retryAfterSec?: number };

export type PairedDeviceResolver = (
  ingress: Extract<RequestIngress, { kind: "polyth-link" }>,
) => AuthPrincipal | null;

export interface AuthServiceOptions {
  /** Persistence file (data/auth.json): password hash + remembered sessions. */
  file: string;
  /** Plaintext password from POLYTH_UI_PASSWORD — hashed at boot, never stored. */
  envPassword?: string | undefined;
  /** POLYTH_UI_PASSWORD_LOCALHOST=optional — public-http loopback skips auth. */
  localhostOptional?: boolean;
  now?: () => number;
  limiter?: LoginRateLimiter;
  /** Session idle expiry in ms (default 30 days). */
  sessionTtlMs?: number;
  /** Cookie name. Include the listen port so instances on one host do not collide. */
  cookieName?: string;
  /** Look up the live paired-device principal. Never reads client headers. */
  resolvePairedDevice?: PairedDeviceResolver;
}

export class AuthorizationError extends Error {
  readonly code: "unauthorized" | "forbidden";
  readonly status: number;
  constructor(code: "unauthorized" | "forbidden", message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
    this.status = code === "unauthorized" ? 401 : 403;
  }
}

export interface AuthService {
  enabled(): boolean;
  cookieName(): string;
  resolve(request: AuthRequestLike, ingress: RequestIngress): AuthResolution;
  requireAuthenticated(request: AuthRequestLike, ingress: RequestIngress): AuthPrincipal;
  requireCapability(principal: AuthPrincipal, capability: string): void;
  /** null = request may proceed; otherwise the 401 to answer with. */
  gate(request: AuthRequestLike, ingress: RequestIngress): GateDenial | null;
  login(password: string, remoteAddr: string | undefined, userAgent?: string): LoginResult;
  logout(token: string | null): void;
  logoutAll(): void;
  listSessions(currentToken: string | null): AuthDeviceDto[];
  revoke(id: string): boolean;
  tokenOf(req: AuthRequestLike): string | null;
  attachPairedDeviceResolver(resolver: PairedDeviceResolver): void;
  statusDto(resolution: AuthResolution): AuthStatusDto;
}

export const AUTH_COOKIE = "polyth_auth";

export const UNTRUSTED_INGRESS_HEADERS = [
  "authorization",
  "cookie",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-polyth-internal-token",
  "x-polyth-link-token",
  "x-polyth-link-connection",
  "x-polyth-link-device",
] as const;

interface StoredSession {
  id: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  label: string;
}

interface AuthFile {
  passwordHash: string | null;
  sessions: StoredSession[];
}

export const isLoopbackAddress = (addr: string | undefined): boolean =>
  !!addr && (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1");

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function parseCookieToken(cookieHeader: string | undefined, cookieName = AUTH_COOKIE): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === cookieName) {
      const v = part.slice(eq + 1).trim();
      return /^[0-9a-f]{64}$/.test(v) ? v : null;
    }
  }
  return null;
}

export function publicHttpIngress(
  req: AuthRequestLike,
  opts: { listenerId?: string; secure?: boolean } = {},
): RequestIngress {
  return {
    kind: "public-http",
    listenerId: opts.listenerId ?? "public",
    loopback: isLoopbackAddress(req.socket.remoteAddress),
    secure: opts.secure === true,
  };
}

export function principalScope(principal: AuthPrincipal): AuthStatusDto["scope"] {
  return principal.kind;
}

export function principalHasCapability(principal: AuthPrincipal, capability: string): boolean {
  if (!capability) return false;
  switch (principal.kind) {
    case "anonymous":
      return false;
    case "local-user":
    case "ui-session":
    case "internal-service":
      return true;
    case "paired-device":
      return principal.grants.includes(capability);
  }
}

export function requirePrincipalCapability(principal: AuthPrincipal, capability: string): void {
  if (principal.kind === "anonymous") {
    throw new AuthorizationError("unauthorized", "authentication required");
  }
  if (!principalHasCapability(principal, capability)) {
    console.warn(`[polyth] authorization denied capability=${capability} principal=${principal.kind}`);
    throw new AuthorizationError("forbidden", "not allowed");
  }
}

export function authCookieHeader(opts: {
  name: string;
  token: string;
  maxAgeSec: number;
  secure: boolean;
}): string {
  const secure = opts.secure ? "; Secure" : "";
  return `${opts.name}=${opts.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${opts.maxAgeSec}${secure}`;
}

export function clearAuthCookieHeader(opts: { name: string; secure: boolean }): string {
  const secure = opts.secure ? "; Secure" : "";
  return `${opts.name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

const ANONYMOUS: AuthPrincipal = { kind: "anonymous" };
const LOCAL_USER: AuthPrincipal = { kind: "local-user", trustedLoopback: true };

export function createAuthService(opts: AuthServiceOptions): AuthService {
  const now = opts.now ?? Date.now;
  const ttl = opts.sessionTtlMs ?? 30 * 24 * 60 * 60_000;
  const limiter = opts.limiter ?? createLoginRateLimiter({ now });
  const cookieName = opts.cookieName ?? AUTH_COOKIE;
  let pairedResolver: PairedDeviceResolver | undefined = opts.resolvePairedDevice;

  let stored: AuthFile = { passwordHash: null, sessions: [] };
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Partial<AuthFile>;
    stored = {
      passwordHash: typeof raw.passwordHash === "string" ? raw.passwordHash : null,
      sessions: Array.isArray(raw.sessions)
        ? raw.sessions.filter((s): s is StoredSession =>
            !!s && typeof s.id === "string" && typeof s.tokenHash === "string" &&
            typeof s.createdAt === "number" && typeof s.lastSeenAt === "number")
            .map((s) => ({ ...s, label: typeof s.label === "string" ? s.label : "" }))
        : [],
    };
  } catch { /* first boot or unreadable — start clean */ }

  // Env password wins but is never written to disk: removing the variable
  // returns to the stored hash (or to auth-off) without editing auth.json.
  const envHash = opts.envPassword ? hashPassword(opts.envPassword) : null;
  const effectiveHash = (): string | null => envHash ?? stored.passwordHash;

  const purge = (): void => {
    const t = now();
    stored.sessions = stored.sessions.filter((s) => t - s.lastSeenAt < ttl);
  };

  const save = (): void => {
    purge();
    mkdirSync(dirname(opts.file), { recursive: true });
    writeFileSync(opts.file, `${JSON.stringify(stored, null, 2)}\n`);
  };
  purge();

  const sessionFor = (token: string | null): StoredSession | null => {
    if (!token) return null;
    const hash = sha256(token);
    const s = stored.sessions.find((x) => x.tokenHash === hash);
    if (!s) return null;
    if (now() - s.lastSeenAt >= ttl) return null;
    return s;
  };

  // lastSeen writes are throttled: an active tab polls constantly and must not
  // turn every request into a disk write.
  const touch = (s: StoredSession): void => {
    const t = now();
    if (t - s.lastSeenAt < 60_000) return;
    s.lastSeenAt = t;
    save();
  };

  const resolvePublicHttp = (req: AuthRequestLike, ingress: Extract<RequestIngress, { kind: "public-http" }>): AuthResolution => {
    const token = parseCookieToken(req.headers.cookie, cookieName);
    const session = sessionFor(token);
    if (session) {
      touch(session);
      const principal: AuthPrincipal = {
        kind: "ui-session",
        sessionId: session.id,
        rememberedDeviceId: session.id,
      };
      return { principal, authenticated: true };
    }
    if (!effectiveHash()) {
      if (ingress.loopback) {
        return { principal: LOCAL_USER, authenticated: true };
      }
      return { principal: ANONYMOUS, authenticated: false };
    }
    if (opts.localhostOptional && ingress.loopback) {
      return { principal: LOCAL_USER, authenticated: true };
    }
    return { principal: ANONYMOUS, authenticated: false };
  };

  const svc: AuthService = {
    enabled: () => effectiveHash() !== null,
    cookieName: () => cookieName,

    attachPairedDeviceResolver(resolver) {
      pairedResolver = resolver;
    },

    resolve(request, ingress) {
      if (ingress.kind === "polyth-link") {
        const paired = pairedResolver?.(ingress) ?? null;
        if (paired && paired.kind === "paired-device" && paired.connectionId === ingress.connectionId) {
          return { principal: paired, authenticated: true };
        }
        return { principal: ANONYMOUS, authenticated: false };
      }
      if (ingress.kind === "internal") {
        return {
          principal: { kind: "internal-service", serviceId: ingress.serviceId },
          authenticated: true,
        };
      }
      return resolvePublicHttp(request, ingress);
    },

    requireAuthenticated(request, ingress) {
      const resolution = svc.resolve(request, ingress);
      if (!resolution.authenticated) {
        throw new AuthorizationError("unauthorized", "authentication required");
      }
      return resolution.principal;
    },

    requireCapability(principal, capability) {
      requirePrincipalCapability(principal, capability);
    },

    gate(request, ingress) {
      const resolution = svc.resolve(request, ingress);
      if (resolution.authenticated) return null;
      return { status: 401, body: { error: "unauthorized", message: "authentication required" } };
    },

    statusDto(resolution) {
      return {
        required: resolution.principal.kind === "paired-device" ? false : svc.enabled(),
        authorized: resolution.authenticated,
        scope: principalScope(resolution.principal),
      };
    },

    tokenOf: (req) => parseCookieToken(req.headers.cookie, cookieName),

    login(password, remoteAddr, userAgent) {
      const hash = effectiveHash();
      if (!hash) {
        return { ok: false, status: 400, error: "auth-disabled", message: "no UI password is configured" };
      }
      const key = rateKeyFor(remoteAddr);
      const rate = limiter.check(key);
      if (!rate.allowed) {
        return {
          ok: false, status: 429, error: "rate-limited",
          message: `too many attempts — try again in ${rate.retryAfterSec}s`,
          retryAfterSec: rate.retryAfterSec,
        };
      }
      if (!verifyPassword(password, hash)) {
        limiter.fail(key);
        return { ok: false, status: 401, error: "invalid-password", message: "wrong password" };
      }
      limiter.succeed(key);
      const token = randomBytes(32).toString("hex");
      const t = now();
      stored.sessions.push({
        id: sha256(token).slice(0, 12),
        tokenHash: sha256(token),
        createdAt: t,
        lastSeenAt: t,
        label: (userAgent ?? "").slice(0, 120),
      });
      save();
      return { ok: true, token };
    },

    logout(token) {
      if (!token) return;
      const hash = sha256(token);
      const before = stored.sessions.length;
      stored.sessions = stored.sessions.filter((s) => s.tokenHash !== hash);
      if (stored.sessions.length !== before) save();
    },

    logoutAll() {
      if (stored.sessions.length === 0) return;
      stored.sessions = [];
      save();
    },

    listSessions(currentToken) {
      purge();
      const currentHash = currentToken ? sha256(currentToken) : null;
      return stored.sessions
        .map((s) => ({
          id: s.id, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, label: s.label,
          current: s.tokenHash === currentHash,
        }))
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    },

    revoke(id) {
      const before = stored.sessions.length;
      stored.sessions = stored.sessions.filter((s) => s.id !== id);
      if (stored.sessions.length !== before) {
        save();
        return true;
      }
      return false;
    },
  };
  return svc;
}
