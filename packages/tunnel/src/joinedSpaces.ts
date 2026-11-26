// Spaces a person here joined on OTHER Polyth servers. This server is that
// person's Link client: one client process and one set of device keys per
// person, one permanently open connection per joined server. Every lookup is
// keyed by the account id, so nobody sees another person's servers or Spaces.
//
//   <rootDir>/<sha256(userId)>/account.json   our cached view
//   <rootDir>/<sha256(userId)>/client/        owned by polyth-link-client
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SpaceRole } from "@polyth/contracts";
import type { JoinedSpace, JoinedSpacesService, ServerPersonNotices } from "@polyth/plugins";
import { createLinkClientProcess, resolveClientBinary, type LinkClientProcess } from "./joinedClient.ts";
import {
  claimProxySession,
  createSpaceGate,
  forwardedRequestHeaders,
  proxyJson,
  readBody,
  refuseUpgrade,
  relayHttp,
  relayUpgrade,
  sendError,
  type ProxySession,
} from "./joinedForward.ts";
import { createNoticeRelay, type NoticeRelay } from "./joinedNotices.ts";

/** The request body cap, the same as this server's own. */
export const FORWARD_BODY_LIMIT = 25 * 1024 * 1024;
const UPDATE_NEEDED = "The other Polyth server needs an update to open this Space here.";
const OFFLINE = "The other Polyth server is not reachable right now.";
const UNKNOWN_SPACE = "unknown space";
const ATTEMPT_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_SPACES = 200;
const METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ROLES = new Set<string>(["viewer", "member", "admin", "owner"]);
const REMOTE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONNECTION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Requests that change which Space the other server remembers for us. */
const SELECTS_SPACE = /^\/api\/spaces(?:\/([^/]+)\/activate)?\/?$/;

export interface JoinedTiming {
  statusMs: number;
  refreshMs: number;
  retryMinMs: number;
  retryMaxMs: number;
  requestMs: number;
  /** Wait for the answer while other forwards are held back behind it. */
  heldMs: number;
  /** How often each Space's notification list is read again. */
  noticeMs: number;
}

const TIMING: JoinedTiming = {
  statusMs: 15_000,
  refreshMs: 5 * 60_000,
  retryMinMs: 1_000,
  retryMaxMs: 60_000,
  requestMs: 20_000,
  heldMs: 60_000,
  noticeMs: 60_000,
};

export interface JoinedServer {
  connectionId: string;
  label: string;
  fingerprint: string;
  online: boolean;
}

interface RemoteSpace {
  id: string;
  name: string;
  color?: string;
  icon?: string;
  role: SpaceRole;
  memberCount: number;
}

interface Connection {
  connectionId: string;
  label: string;
  spaces: RemoteSpace[];
  session: ProxySession | null;
  online: boolean;
  revoked: boolean;
  /** Whether the other server honours `x-polyth-space`; absent until probed. */
  spaceHeader?: boolean;
  /** The Space the other server remembers for us; absent while uncertain. */
  activeSpaceId?: string;
  /** This person's account id there (`SpacesStateDto.user.id`). */
  remoteUserId?: string;
  gate: ReturnType<typeof createSpaceGate>;
  /** Ways to cut the exchanges running over this connection. */
  live: Set<() => void>;
  notices: NoticeRelay;
  timer?: ReturnType<typeof setTimeout>;
  ticking: Promise<void> | null;
  failures: number;
  refreshedAt: number;
  dropped: boolean;
}

interface Person {
  userId: string;
  connections: Map<string, Connection>;
  /** Pairing attempts of this person: id → expiry. */
  attempts: Map<string, number>;
  confirming: Set<string>;
  client: LinkClientProcess | null;
  started: boolean;
  /** A pairing may have been saved by the client but not yet by us. */
  unsynced: boolean;
  crashes: number;
  removed: boolean;
}

export class JoinedError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const joinedSpaceId = (userId: string, connectionId: string, remoteSpaceId: string): string =>
  `rmt_${sha256(`${userId}\0${connectionId}\0${remoteSpaceId}`).slice(0, 24)}`;

const fingerprint = (connectionId: string): string => `${connectionId.slice(0, 4)}…${connectionId.slice(-4)}`;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

const text = (value: unknown, limit = 200): string => typeof value === "string" ? value.slice(0, limit) : "";

/** The other server's Space list is its data: keep only well-formed entries. */
function remoteSpaces(value: unknown): RemoteSpace[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SPACES).flatMap((entry): RemoteSpace[] => {
    const space = record(entry);
    if (typeof space.id !== "string" || !REMOTE_ID.test(space.id) || !ROLES.has(String(space.role))) return [];
    const color = text(space.color, 64);
    const icon = text(space.icon, 64);
    return [{
      id: space.id,
      name: text(space.name) || space.id,
      ...(color ? { color } : {}),
      ...(icon ? { icon } : {}),
      role: space.role as SpaceRole,
      memberCount: Number.isSafeInteger(space.memberCount) ? space.memberCount as number : 1,
    }];
  });
}

export function createJoinedSpaces(options: {
  /** The directory holding every person's data; outside every Space. */
  rootDir: () => string;
  /** What the other server calls this device. */
  deviceLabel: () => string;
  env?: NodeJS.ProcessEnv;
  timing?: Partial<JoinedTiming>;
  /** Where a person's notifications from joined Spaces go; resolved late. */
  notices?: () => ServerPersonNotices | undefined;
}) {
  const timing = { ...TIMING, ...options.timing };
  const people = new Map<string, Person>();
  const removing = new Set<string>();
  let enabled = false;

  const personDir = (userId: string): string => join(options.rootDir(), sha256(userId).slice(0, 32));

  const newConnection = (person: Person, connectionId: string, label: string, spaces: RemoteSpace[] = [], saved?: unknown): Connection => ({
    connectionId, label, spaces, session: null, online: false, revoked: false,
    gate: createSpaceGate(), live: new Set(), ticking: null, failures: 0, refreshedAt: 0, dropped: false,
    notices: createNoticeRelay({
      userId: person.userId,
      sink: () => options.notices?.(),
      timing,
      saved,
      changed: () => {
        try { save(person); }
        catch { console.error("[polyth-link] joined-server state could not be saved"); }
      },
    }),
  });

  const save = (person: Person): void => {
    if (person.removed) return;
    const dir = personDir(person.userId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(options.rootDir(), 0o700);
    chmodSync(dir, 0o700);
    const file = join(dir, "account.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({
      userId: person.userId,
      unsynced: person.unsynced,
      connections: [...person.connections.values()].map((conn) => ({
        connectionId: conn.connectionId, label: conn.label, spaces: conn.spaces, notices: conn.notices.saved(),
        ...(conn.remoteUserId ? { remoteUserId: conn.remoteUserId } : {}),
      })),
    }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };

  const readAccount = (file: string): Record<string, unknown> | null => {
    try {
      return record(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[polyth-link] unreadable joined-server state");
      return null;
    }
  };

  const load = (userId: string, create: boolean): Person | undefined => {
    const known = people.get(userId);
    if (known) return known;
    if (!enabled || removing.has(userId)) return undefined;
    const saved = readAccount(join(personDir(userId), "account.json"));
    const mine = saved?.userId === userId ? saved : null;
    if (!mine && !create) return undefined;
    const person: Person = {
      userId, connections: new Map(), attempts: new Map(), confirming: new Set(), client: null,
      started: false, unsynced: mine?.unsynced === true, crashes: 0, removed: false,
    };
    for (const entry of Array.isArray(mine?.connections) ? mine.connections : []) {
      const conn = record(entry);
      if (typeof conn.connectionId !== "string" || !CONNECTION_ID.test(conn.connectionId)) continue;
      const restored = newConnection(person, conn.connectionId, text(conn.label), remoteSpaces(conn.spaces), conn.notices);
      if (typeof conn.remoteUserId === "string" && conn.remoteUserId) restored.remoteUserId = conn.remoteUserId;
      person.connections.set(conn.connectionId, restored);
    }
    people.set(userId, person);
    if (!mine) save(person);
    return person;
  };

  const goOffline = (conn: Connection): void => {
    conn.notices.offline();
    conn.online = false;
    conn.session = null;
    conn.spaceHeader = undefined;
    conn.activeSpaceId = undefined;
    for (const cut of [...conn.live]) cut();
    conn.live.clear();
  };

  const clientFor = (person: Person): LinkClientProcess => {
    if (!enabled || person.removed) throw new JoinedError(503, "unavailable", "Joining other servers is not available right now.");
    if (person.client) return person.client;
    const binary = resolveClientBinary(options.env ? { env: options.env } : {});
    if (!binary) throw new JoinedError(503, "unavailable", "The Polyth Link client is not installed on this server.");
    save(person);
    const client = createLinkClientProcess({
      binary,
      dataDir: join(personDir(person.userId), "client"),
      ...(options.env ? { env: options.env } : {}),
    });
    client.onExit((livedMs) => {
      if (person.client !== client) return;
      // The sessions died with it; restart each with a growing delay.
      person.crashes = livedMs > timing.retryMaxMs ? 1 : person.crashes + 1;
      person.attempts.clear();
      for (const conn of person.connections.values()) {
        goOffline(conn);
        conn.failures = Math.max(conn.failures, person.crashes);
        if (!conn.ticking) schedule(person, conn);
      }
    });
    person.client = client;
    return client;
  };

  /** Stops a client that has nothing left to hold open. */
  const releaseIfIdle = async (person: Person): Promise<void> => {
    if (person.connections.size || person.attempts.size || !person.client) return;
    const client = person.client;
    person.client = null;
    person.started = false;
    await client.close();
  };

  /** Reads the other server's Spaces, and once per connection whether it
   *  honours the Space header. */
  const refresh = async (person: Person, conn: Connection): Promise<void> => {
    const session = conn.session;
    if (!session) return;
    const release = await conn.gate.shared();
    try {
      const answer = await proxyJson(session, { path: "/api/spaces", timeoutMs: timing.requestMs });
      if (conn.session !== session) return;
      conn.refreshedAt = Date.now();
      if (answer.status >= 500) throw new JoinedError(503, "unavailable", OFFLINE);
      if (answer.status !== 200) return;
      const state = record(answer.body);
      if (!Array.isArray(state.spaces)) throw new JoinedError(503, "unavailable", OFFLINE);
      const spaces = remoteSpaces(state.spaces);
      const active = typeof state.activeSpaceId === "string" ? state.activeSpaceId : undefined;
      let honoured = conn.spaceHeader;
      const other = spaces.find((space) => space.id !== active);
      if (honoured !== true && spaces.length > 1 && other) {
        const probe = await proxyJson(session, { path: "/api/spaces", spaceId: other.id, timeoutMs: timing.requestMs });
        if (conn.session !== session) return;
        const seen = record(probe.body).activeSpaceId;
        honoured = probe.status === 200 && typeof seen === "string" ? seen === other.id : undefined;
      }
      conn.activeSpaceId = active;
      const user = record(state.user).id;
      if (typeof user === "string" && user) conn.remoteUserId = user;
      conn.spaceHeader = honoured;
      conn.spaces = spaces;
      save(person);
    } finally {
      release();
    }
  };

  const maintain = async (person: Person, conn: Connection): Promise<void> => {
    const client = clientFor(person);
    const params = { connectionId: conn.connectionId };
    if (!conn.session) {
      const connected = record(await client.invoke("connect", params));
      const session = await claimProxySession(connected.bootstrapUrl, timing.requestMs);
      if (conn.dropped) return;
      conn.session = session;
      await refresh(person, conn);
      conn.online = conn.session === session;
      return;
    }
    const session = conn.session;
    const status = record(await client.invoke("status", params));
    if (conn.dropped || conn.session !== session) return;
    if (status.state === "revoked") throw new JoinedError(409, "device-revoked", "revoked");
    if (status.state !== "connected" || (typeof status.origin === "string" && !status.origin.endsWith(`:${session.port}`))) {
      throw new JoinedError(503, "unavailable", OFFLINE);
    }
    if (status.reconnecting === true) {
      conn.online = false;
      // Listening starts over, with a catch-up read, once the link is back.
      conn.notices.offline();
      return;
    }
    // Back after a lost link: the other server may have restarted or changed.
    if (!conn.online) conn.spaceHeader = undefined;
    if (!conn.online || Date.now() - conn.refreshedAt >= timing.refreshMs) await refresh(person, conn);
    conn.online = conn.session === session;
  };

  /** Selects the Space the other server remembers for us, which is where an
   *  upgrade lands: the upgrade itself carries none. Call it holding the
   *  exclusive gate. Returns the refusal's status, 0 once selected. */
  const select = async (conn: Connection, session: ProxySession, spaceId: string): Promise<number> => {
    const before = conn.activeSpaceId;
    conn.activeSpaceId = undefined;
    const answer = await proxyJson(session, {
      method: "POST",
      path: `/api/spaces/${spaceId}/activate`,
      spaceId,
      timeoutMs: timing.requestMs,
    });
    // A view-only device may not switch, but may already be there.
    if (answer.status !== 200 && !(answer.status === 403 && before === spaceId)) {
      if (answer.status !== 403 && answer.status !== 404) return 503;
      conn.activeSpaceId = before;
      return answer.status;
    }
    conn.activeSpaceId = spaceId;
    return 0;
  };

  /** Hands the connection's current state to its notification relay. */
  const relayNotices = (person: Person, conn: Connection): void => {
    const session = conn.session;
    if (!options.notices || !session || !conn.online || conn.dropped || person.removed) return;
    const holds = (spaceId: string): boolean => conn.spaceHeader === true || conn.activeSpaceId === spaceId;
    conn.notices.sync({
      connectionId: conn.connectionId,
      session,
      serverLabel: conn.label || fingerprint(conn.connectionId),
      spaces: conn.spaces.map((space) => ({
        id: space.id, name: space.name, joinedId: joinedSpaceId(person.userId, conn.connectionId, space.id),
      })),
      async read(spaceId) {
        const release = await conn.gate.shared();
        try {
          // Without header support only the remembered Space can be asked for.
          if (conn.session !== session || !holds(spaceId)) return null;
          return await proxyJson(session, { path: "/api/notifications", spaceId, timeoutMs: timing.requestMs });
        } finally {
          release();
        }
      },
      async inSpace(spaceId, open) {
        const release = await conn.gate.exclusive();
        try {
          if (conn.session !== session) return false;
          // An older server's remembered Space is never moved for this: its
          // forwarded requests depend on it.
          if (conn.activeSpaceId !== spaceId
            && (conn.spaceHeader !== true || await select(conn, session, spaceId) !== 0)) return false;
          await open();
          return true;
        } finally {
          release();
        }
      },
    });
  };

  const schedule = (person: Person, conn: Connection, soon = false): void => {
    clearTimeout(conn.timer);
    if (!enabled || person.removed || conn.dropped || conn.revoked) return;
    const delay = conn.failures
      ? Math.min(timing.retryMinMs * 2 ** Math.min(conn.failures - 1, 20), timing.retryMaxMs)
      : soon ? 0 : timing.statusMs;
    conn.timer = setTimeout(() => { void tick(person, conn); }, delay);
    conn.timer.unref?.();
  };

  /** One step of keeping a connection open; never rejects. */
  const tick = (person: Person, conn: Connection): Promise<void> => {
    if (conn.ticking) return conn.ticking;
    clearTimeout(conn.timer);
    if (!enabled || person.removed || conn.dropped) return Promise.resolve();
    conn.ticking = (async () => {
      try {
        await maintain(person, conn);
        conn.failures = 0;
        relayNotices(person, conn);
      } catch (error) {
        if ((error as { code?: string }).code === "device-revoked") {
          conn.revoked = true;
          conn.notices.leave();
        } else conn.failures += 1;
        goOffline(conn);
      } finally {
        conn.ticking = null;
        schedule(person, conn);
      }
    })();
    return conn.ticking;
  };

  /** Brings our list in line with the client's, which owns the identities. */
  const sync = async (person: Person): Promise<void> => {
    const listed = await clientFor(person).invoke("connections.list");
    if (!Array.isArray(listed)) return;
    const present = new Set<string>();
    for (const entry of listed) {
      const item = record(entry);
      if (typeof item.id !== "string" || !CONNECTION_ID.test(item.id)) continue;
      present.add(item.id);
      const conn = person.connections.get(item.id) ?? newConnection(person, item.id, "");
      conn.label = text(item.hostLabel);
      conn.revoked = item.revoked === true;
      if (conn.revoked) conn.notices.leave();
      person.connections.set(item.id, conn);
    }
    for (const [id, conn] of person.connections) {
      if (present.has(id)) continue;
      conn.dropped = true;
      clearTimeout(conn.timer);
      conn.notices.leave();
      goOffline(conn);
      person.connections.delete(id);
    }
    person.unsynced = false;
    save(person);
  };

  const startPerson = (person: Person): void => {
    if (person.started) return;
    person.started = true;
    void (async () => {
      try {
        await sync(person);
      } catch (error) {
        console.error("[polyth-link] joined servers could not be listed", (error as { code?: string }).code ?? "error");
      }
      for (const conn of person.connections.values()) void tick(person, conn);
    })();
  };

  const stopPerson = async (person: Person): Promise<void> => {
    for (const conn of person.connections.values()) {
      conn.dropped = true;
      clearTimeout(conn.timer);
      goOffline(conn);
    }
    const client = person.client;
    person.client = null;
    await client?.close();
  };

  const serverDto = (conn: Connection): JoinedServer => ({
    connectionId: conn.connectionId,
    label: conn.label || fingerprint(conn.connectionId),
    fingerprint: fingerprint(conn.connectionId),
    online: conn.online,
  });

  const joinedDto = (userId: string, conn: Connection, space: RemoteSpace): JoinedSpace => ({
    ...space,
    id: joinedSpaceId(userId, conn.connectionId, space.id),
    serverLabel: conn.label || fingerprint(conn.connectionId),
    connectionId: conn.connectionId,
    online: conn.online,
    ...(conn.remoteUserId ? { remoteUserId: conn.remoteUserId } : {}),
  });

  const spacesOf = (userId: string, conn: Connection): JoinedSpace[] =>
    conn.spaces.map((space) => joinedDto(userId, conn, space));

  const list = (userId: string): JoinedSpace[] => {
    const person = enabled ? people.get(userId) : undefined;
    return person ? [...person.connections.values()].flatMap((conn) => spacesOf(userId, conn)) : [];
  };

  const locate = (userId: string, id: string): { person: Person; conn: Connection; space: RemoteSpace } | undefined => {
    const person = enabled ? people.get(userId) : undefined;
    if (!person) return undefined;
    for (const conn of person.connections.values()) {
      const space = conn.spaces.find((candidate) => joinedSpaceId(userId, conn.connectionId, candidate.id) === id);
      if (space) return { person, conn, space };
    }
    return undefined;
  };

  const tracker = (conn: Connection) => (cut: () => void): (() => void) => {
    conn.live.add(cut);
    return () => { conn.live.delete(cut); };
  };

  /** Something on the way failed: check the connection now, not at the next poll. */
  const suspect = (person: Person, conn: Connection): void => {
    if (!conn.failures && !conn.ticking) schedule(person, conn, true);
  };

  const service: JoinedSpacesService = {
    list,
    get: (userId, id) => {
      const found = locate(userId, id);
      return found && joinedDto(userId, found.conn, found.space);
    },
    async forwardHttp(userId, id, { method: rawMethod, path, req, res }) {
      const found = locate(userId, id);
      const method = rawMethod.toUpperCase();
      if (!found || !path.startsWith("/api/")) {
        req.resume();
        sendError(res, 404, "not-found", UNKNOWN_SPACE);
        return;
      }
      const { person, conn, space } = found;
      const session = conn.session;
      if (!METHODS.has(method)) {
        req.resume();
        sendError(res, 405, "invalid-input", "That method cannot be forwarded.");
        return;
      }
      if (!conn.online || !session) {
        req.resume();
        sendError(res, 503, "unavailable", OFFLINE);
        return;
      }
      const body = await readBody(req, FORWARD_BODY_LIMIT);
      if (body === "aborted") {
        res.destroy();
        return;
      }
      if (body === "too-large") {
        res.setHeader("connection", "close");
        sendError(res, 413, "payload-too-large", "That request is too large to send to the other server.");
        return;
      }
      const selection = method !== "GET" && method !== "HEAD" && method !== "OPTIONS"
        ? SELECTS_SPACE.exec(path.split("?")[0]!) : null;
      const legacy = conn.spaceHeader !== true;
      // A request that moves the remembered Space goes alone. Without header
      // support every other one rides on that Space, so it must not move
      // until the other server has started answering.
      const release = selection ? await conn.gate.exclusive() : legacy ? await conn.gate.shared() : null;
      if (conn.session !== session || !conn.online) {
        release?.();
        sendError(res, 503, "unavailable", OFFLINE);
        return;
      }
      if (conn.spaceHeader !== true && conn.activeSpaceId !== space.id) {
        release?.();
        sendError(res, 503, "unavailable", UPDATE_NEEDED);
        return;
      }
      if (selection) conn.activeSpaceId = undefined;
      await relayHttp(session, {
        method,
        path,
        headers: {
          ...forwardedRequestHeaders(req.headers),
          "x-polyth-space": space.id,
          ...(MUTATIONS.has(method) || body.length ? { "content-length": body.length } : {}),
        },
        body: body.length ? body : null,
        res,
        ...(release ? { headerTimeoutMs: timing.heldMs } : {}),
        answered(status) {
          if (selection) {
            if (selection[1] && status === 200) conn.activeSpaceId = selection[1];
            else {
              conn.refreshedAt = 0;
              suspect(person, conn);
            }
          }
          if (status === 0 && !res.destroyed) suspect(person, conn);
          release?.();
          // Read or cleared through here: withdraw it here without waiting.
          if (status === 200 && method === "POST" && path.startsWith("/api/notifications/")) conn.notices.refresh(space.id);
        },
        track: tracker(conn),
        unavailable: OFFLINE,
      });
    },
    async forwardUpgrade(userId, id, { path, req, socket, head }) {
      socket.on("error", () => {});
      const found = locate(userId, id);
      if (!found || !/^\/ws(?:[/?][\x21-\x7e]*)?$/.test(path)) {
        refuseUpgrade(socket, 404);
        return;
      }
      const { person, conn, space } = found;
      const session = conn.session;
      if (!conn.online || !session) {
        refuseUpgrade(socket, 503);
        return;
      }
      // The upgrade carries no Space: the other server takes the one it
      // remembers, so it is selected first and stays selected until the 101.
      const release = await conn.gate.exclusive();
      try {
        if (conn.session !== session || socket.destroyed) {
          refuseUpgrade(socket, 503);
          return;
        }
        const refused = await select(conn, session, space.id);
        if (refused) {
          if (refused === 503) {
            conn.refreshedAt = 0;
            suspect(person, conn);
          }
          refuseUpgrade(socket, refused);
          return;
        }
        if (conn.session !== session) {
          refuseUpgrade(socket, 503);
          return;
        }
        await relayUpgrade(session, { path, req, socket, head, timeoutMs: timing.heldMs, track: tracker(conn) });
      } catch {
        refuseUpgrade(socket, 503);
        conn.refreshedAt = 0;
        suspect(person, conn);
      } finally {
        release();
      }
    },
  };

  /** The person a route acts for; throws when this server cannot join. */
  const acting = (userId: string): Person => {
    const person = load(userId, true);
    if (!person) throw new JoinedError(503, "unavailable", "Joining other servers is not available right now.");
    return person;
  };

  const existing = (userId: string, connectionId: string): { person: Person; conn: Connection } => {
    const person = load(userId, false);
    const conn = person?.connections.get(connectionId);
    if (!person || !conn) throw new JoinedError(404, "not-found", "unknown server");
    return { person, conn };
  };

  const ownAttempt = (userId: string, attemptId: string): Person => {
    const person = load(userId, false);
    if (!person || (person.attempts.get(attemptId) ?? 0) <= Date.now()) {
      throw new JoinedError(404, "not-found", "unknown pairing");
    }
    return person;
  };

  const expireAttempts = (person: Person): void => {
    for (const [id, expiry] of person.attempts) if (expiry <= Date.now()) person.attempts.delete(id);
  };

  return {
    service,

    overview(userId: string): { servers: JoinedServer[]; spaces: JoinedSpace[] } {
      const person = load(userId, false);
      if (person?.connections.size) startPerson(person);
      return {
        servers: person ? [...person.connections.values()].map(serverDto) : [],
        spaces: list(userId),
      };
    },

    async parse(userId: string, ticket: string) {
      const parsed = record(await clientFor(acting(userId)).invoke("pairing.parse", { ticket }));
      return {
        hostLabel: text(parsed.hostLabel),
        fingerprint: text(parsed.hostFingerprint),
        expiresAt: parsed.expiresAt,
        // An invitation ticket has nobody on the other side to compare words
        // with; the inviting server confirms it by itself.
        invitation: parsed.invitation === true,
      };
    },

    async begin(userId: string, ticket: string) {
      const person = acting(userId);
      expireAttempts(person);
      if (person.attempts.size >= MAX_ATTEMPTS) {
        throw new JoinedError(429, "request-rate-limited", "Too many pairings are waiting. Cancel one first.");
      }
      const begun = record(await clientFor(person).invoke("pairing.begin", { ticket, label: options.deviceLabel() }));
      if (typeof begun.attemptId !== "string" || !begun.attemptId) {
        throw new JoinedError(503, "unavailable", "The pairing did not start.");
      }
      person.attempts.set(begun.attemptId, Date.now() + ATTEMPT_TTL_MS);
      return { attemptId: begun.attemptId, safetyPhrase: begun.safetyPhrase };
    },

    async confirm(userId: string, attemptId: string): Promise<{ server: JoinedServer; spaces: JoinedSpace[] }> {
      const person = ownAttempt(userId, attemptId);
      if (person.confirming.has(attemptId)) {
        throw new JoinedError(409, "conflict", "This pairing is already being confirmed.");
      }
      const client = clientFor(person);
      person.confirming.add(attemptId);
      person.unsynced = true;
      save(person);
      let connectionId: string;
      try {
        const confirmed = record(await client.invoke("pairing.confirm", { attemptId }));
        connectionId = text(confirmed.connectionId, 256);
        if (!CONNECTION_ID.test(connectionId)) throw new JoinedError(503, "unavailable", "The pairing did not finish.");
      } catch (error) {
        person.attempts.delete(attemptId);
        await releaseIfIdle(person);
        throw error;
      } finally {
        person.confirming.delete(attemptId);
      }
      person.attempts.delete(attemptId);
      const previous = person.connections.get(connectionId);
      const conn = previous ?? newConnection(person, connectionId, "");
      person.connections.set(connectionId, conn);
      person.started = true;
      // Paired again: whatever the old session was, it is replaced.
      await conn.ticking;
      goOffline(conn);
      conn.revoked = false;
      conn.failures = 0;
      try {
        const listed = await client.invoke("connections.list");
        const item = Array.isArray(listed) ? listed.map(record).find((entry) => entry.id === connectionId) : undefined;
        conn.label = text(item?.hostLabel) || conn.label;
      } catch { /* the fingerprint stands in until the next start */ }
      person.unsynced = false;
      save(person);
      await tick(person, conn);
      return { server: serverDto(conn), spaces: spacesOf(userId, conn) };
    },

    async cancel(userId: string, attemptId: string): Promise<void> {
      const person = ownAttempt(userId, attemptId);
      await clientFor(person).invoke("pairing.cancel", { attemptId });
      person.attempts.delete(attemptId);
      await releaseIfIdle(person);
    },

    async rename(userId: string, connectionId: string, label: string): Promise<JoinedServer> {
      const { person, conn } = existing(userId, connectionId);
      const renamed = record(await clientFor(person).invoke("connections.rename", { connectionId, label }));
      conn.label = text(renamed.hostLabel);
      save(person);
      return serverDto(conn);
    },

    /** Disconnects and forgets one server, its device identity included. */
    async remove(userId: string, connectionId: string): Promise<void> {
      const { person, conn } = existing(userId, connectionId);
      const client = clientFor(person);
      conn.dropped = true;
      clearTimeout(conn.timer);
      goOffline(conn);
      await conn.ticking;
      try {
        await client.invoke("forget", { connectionId });
      } catch (error) {
        conn.dropped = false;
        schedule(person, conn, true);
        throw error;
      }
      conn.notices.leave();
      goOffline(conn);
      person.connections.delete(connectionId);
      save(person);
      await releaseIfIdle(person);
    },

    /** The account is being removed: its client stops and its keys go. */
    async removeAccount(userId: string): Promise<void> {
      removing.add(userId);
      try {
        const person = people.get(userId);
        if (person) {
          person.removed = true;
          people.delete(userId);
          await stopPerson(person);
        }
        await rm(personDir(userId), { recursive: true, force: true, maxRetries: 3 });
      } finally {
        // Held a little longer: the credential goes only after the listeners.
        setTimeout(() => removing.delete(userId), 60_000).unref();
      }
    },

    /** Opens the connections of everyone who has any. */
    start(): void {
      if (enabled) return;
      enabled = true;
      let names: string[] = [];
      try {
        names = readdirSync(options.rootDir());
      } catch { /* nobody joined anything yet */ }
      for (const name of names) {
        const userId = readAccount(join(options.rootDir(), name, "account.json"))?.userId;
        if (typeof userId !== "string" || personDir(userId) !== join(options.rootDir(), name)) continue;
        const person = load(userId, false);
        if (person && (person.connections.size || person.unsynced)) startPerson(person);
      }
    },

    async stop(): Promise<void> {
      enabled = false;
      const all = [...people.values()];
      people.clear();
      await Promise.all(all.map(stopPerson));
    },
  };
}

export type JoinedSpaces = ReturnType<typeof createJoinedSpaces>;
