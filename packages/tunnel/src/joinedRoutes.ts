// `/api/tunnel/joined`: a signed-in person manages the other Polyth servers
// THEY joined. Deliberately absent from TUNNEL_REMOTE_ACCESS: a paired device,
// a command-line token or an internal service never acts here.
import type { RouteHandler, RouteRequest } from "@polyth/contracts";
import { JoinedError, type JoinedSpaces } from "./joinedSpaces.ts";

const BASE = "/api/tunnel/joined";
const TICKET_LIMIT = 16 * 1024;

/** What the Link client's error codes mean to the person pairing. */
const CLIENT_ERRORS: Readonly<Record<string, readonly [number, string]>> = {
  "pairing-invalid": [400, "That pairing link is not valid."],
  "pairing-expired": [410, "That pairing link has expired."],
  "pairing-claimed": [409, "That pairing link was already used."],
  "pairing-rejected": [409, "The other server rejected the pairing."],
  "pairing-cancelled": [409, "The pairing was cancelled."],
  "pairing-storage-failed": [500, "The pairing could not be saved."],
  "host-identity-mismatch": [409, "The server that answered is not the one in the pairing link."],
  "device-unknown": [404, "unknown server"],
  "device-revoked": [409, "The other server revoked this connection."],
};

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

function requirePerson({ principal, ingress }: Pick<RouteRequest, "principal" | "ingress">): void {
  if (principal.kind === "anonymous") throw fail("unauthorized", "authentication required");
  const person = ingress.kind === "public-http"
    && (principal.kind === "ui-session" || (principal.kind === "local-user" && ingress.loopback));
  if (!person) throw fail("forbidden", "not allowed");
}

async function field(request: RouteRequest, name: string, limit: number): Promise<string> {
  const value = (await request.body())[name];
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw fail("invalid-input", `${name} is required`);
  }
  return value.trim();
}

export function joinedRoutes(joined: JoinedSpaces): RouteHandler {
  const answer = async (request: RouteRequest, work: () => unknown): Promise<void> => {
    try {
      request.json(200, await work());
    } catch (error) {
      if (error instanceof JoinedError) {
        request.json(error.status, { error: error.code, message: error.message });
        return;
      }
      const code = (error as { code?: unknown }).code;
      if (typeof code !== "string" || !/^(?:pairing|host|device|transport|relay|direct|proxy|request|link-client)-/.test(code)) throw error;
      const [status, message] = CLIENT_ERRORS[code] ?? [503, "The other Polyth server is not reachable right now."];
      request.json(status, { error: code, message });
    }
  };

  return async (request) => {
    const { path, method } = request;
    if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
    requirePerson(request);
    const userId = request.space.userId;
    if (path === BASE && method === "GET") {
      await answer(request, () => joined.overview(userId));
      return true;
    }
    const pair = method === "POST" ? path.slice(BASE.length).match(/^\/pair\/(parse|begin|confirm|cancel)$/)?.[1] : undefined;
    if (pair === "parse" || pair === "begin") {
      const ticket = await field(request, "ticket", TICKET_LIMIT);
      await answer(request, () => joined[pair](userId, ticket));
      return true;
    }
    if (pair === "confirm" || pair === "cancel") {
      const attemptId = await field(request, "attemptId", 128);
      await answer(request, async () => {
        if (pair === "confirm") return joined.confirm(userId, attemptId);
        await joined.cancel(userId, attemptId);
        return { ok: true };
      });
      return true;
    }
    const connectionId = path.slice(BASE.length).match(/^\/([A-Za-z0-9_-]{1,128})$/)?.[1];
    if (connectionId && method === "PATCH") {
      const label = (await request.body()).label;
      // An empty label goes back to the other server's own name.
      if (typeof label !== "string" || label.length > 80) throw fail("invalid-input", "label is required");
      await answer(request, async () => ({ server: await joined.rename(userId, connectionId, label.trim()) }));
      return true;
    }
    if (connectionId && method === "DELETE") {
      await answer(request, async () => {
        await joined.remove(userId, connectionId);
        return { ok: true };
      });
      return true;
    }
    request.json(404, { error: "not-found", message: "unknown route" });
    return true;
  };
}
