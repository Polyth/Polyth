// What the server knows about a spoken conversation: a short lease saying
// "this person hears this conversation's replies read aloud right now". The
// browser renews it while voice mode is on with spoken replies and drops it
// when it ends; a closed tab simply lets it lapse.
//
// The lease has one use: while it holds, every turn that person sends in that
// conversation carries a `<polyth-voice>` block, so the agent answers the way
// one speaks — the answer first, in a sentence or two — instead of writing a
// page that is then read out. The block goes through the host's turn-context
// seam, so it is persisted with the admitted message like every other
// model-visible fact; nothing here touches history itself.
//
// Scope comes first, as in the narrator route: a session outside the
// request's Space answers exactly like one that does not exist. A lease is
// per person; another member's turn in the same conversation is unaffected.
import type { RouteHandler, SessionService, SpaceContext } from "@polyth/contracts";
import type { TurnContextContributor } from "@polyth/plugins";

export const VOICE_LIVE_PATH = "/api/voice-mode/live";
/** A lease not renewed for this long is over (the client renews every 30 s). */
export const VOICE_LIVE_TTL_MS = 90_000;
export const VOICE_LIVE_RENEW_MS = 30_000;
/** A New chat's lease names no conversation yet: it attaches to the first
 *  turn of a conversation created at most this long ago. */
export const VOICE_NEW_CHAT_MS = 120_000;
const MAX_LEASES_PER_PERSON = 8;
const MAX_LEASES = 2_000;

export interface VoiceLiveRequest {
  /** The pinned conversation; null while a New chat has not been sent. */
  sessionId: string | null;
  live: boolean;
}

export interface VoiceLiveDeps {
  forSpace(space: SpaceContext): { sessions: Pick<SessionService, "snapshot"> };
  now(): number;
}

export const VOICE_TURN_BLOCK = [
  "<polyth-voice>",
  "This person is in voice mode: your reply is read aloud to them as it streams, and they may not be looking at the screen.",
  "- Give the answer in the first one or two short sentences, in plain spoken language and in the language they speak.",
  "- Before long work, say in one short sentence what you are about to do.",
  "- Tables, code blocks and long lists are not read aloud: put them after the spoken answer and say they are on screen.",
  "- Do not read out paths, URLs, hashes or long identifiers; name the thing instead.",
  "</polyth-voice>",
].join("\n");

export function parseVoiceLiveRequest(body: unknown): VoiceLiveRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  if (typeof data.live !== "boolean") return null;
  if (data.sessionId === null || data.sessionId === undefined) return { sessionId: null, live: data.live };
  if (typeof data.sessionId !== "string" || !data.sessionId || data.sessionId.length > 200) return null;
  return { sessionId: data.sessionId, live: data.live };
}

export interface VoiceLive {
  routes: RouteHandler;
  contributor: TurnContextContributor;
  dispose(): void;
}

export function createVoiceLive(deps: VoiceLiveDeps): VoiceLive {
  /** person → conversation ("" for a New chat) → lease end. */
  const leases = new Map<string, Map<string, number>>();
  let count = 0;

  const person = (space: Pick<SpaceContext, "spaceId" | "userId">, userId = space.userId) => `${space.spaceId}\n${userId}`;

  const prune = () => {
    const now = deps.now();
    for (const [key, own] of leases) {
      for (const [sessionId, expiresAt] of own) {
        if (expiresAt > now) continue;
        own.delete(sessionId);
        count--;
      }
      if (!own.size) leases.delete(key);
    }
  };

  const drop = (key: string, sessionId: string) => {
    const own = leases.get(key);
    if (!own?.delete(sessionId)) return;
    count--;
    if (!own.size) leases.delete(key);
  };

  const hold = (key: string, sessionId: string, expiresAt: number): boolean => {
    let own = leases.get(key);
    if (!own?.has(sessionId)) {
      if ((own?.size ?? 0) >= MAX_LEASES_PER_PERSON || count >= MAX_LEASES) return false;
      count++;
    }
    if (!own) {
      own = new Map();
      leases.set(key, own);
    }
    own.set(sessionId, expiresAt);
    return true;
  };

  const routes: RouteHandler = async (rc) => {
    if (rc.path !== VOICE_LIVE_PATH || rc.method !== "POST") return false;
    const request = parseVoiceLiveRequest(await rc.body());
    if (!request) {
      rc.json(400, { error: "invalid-input", message: "sessionId (or null) and live are required" });
      return true;
    }
    const key = person(rc.space);
    if (!request.live) {
      drop(key, request.sessionId ?? "");
      rc.json(200, { live: false });
      return true;
    }
    if (request.sessionId !== null) {
      try {
        const projection = await deps.forSpace(rc.space).sessions.snapshot(request.sessionId);
        // A people-only conversation has no agent to give the hint to.
        if (projection.purpose === "conversation") throw new Error("no agent");
      } catch {
        rc.json(404, { error: "not-found", message: "Session unavailable" });
        return true;
      }
    }
    prune();
    if (!hold(key, request.sessionId ?? "", deps.now() + VOICE_LIVE_TTL_MS)) {
      rc.json(429, { error: "rate-limited", message: "Too many spoken conversations" });
      return true;
    }
    // The New chat got its conversation: one lease, not two.
    if (request.sessionId !== null) drop(key, "");
    rc.json(200, { live: true, ttlMs: VOICE_LIVE_TTL_MS });
    return true;
  };

  const contributor: TurnContextContributor = async ({ space, sessionId, userId }) => {
    if (!userId) return "";
    const key = person(space, userId);
    const own = leases.get(key);
    if (!own) return "";
    const now = deps.now();
    if ((own.get(sessionId) ?? 0) > now) return VOICE_TURN_BLOCK;
    const fresh = own.get("") ?? 0;
    if (fresh <= now) return "";
    // A New chat's first message: the conversation did not exist when the
    // lease was taken. Only a conversation created just now can be it; an
    // older one this person also writes in is not the spoken one.
    try {
      const projection = await deps.forSpace(space).sessions.snapshot(sessionId);
      if (projection.purpose === "conversation" || now - projection.createdAt > VOICE_NEW_CHAT_MS) return "";
    } catch {
      return "";
    }
    drop(key, "");
    hold(key, sessionId, fresh);
    return VOICE_TURN_BLOCK;
  };

  return {
    routes,
    contributor,
    dispose() {
      leases.clear();
      count = 0;
    },
  };
}
