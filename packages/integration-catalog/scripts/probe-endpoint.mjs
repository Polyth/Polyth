// Probe remote MCP endpoints the way a catalog entry needs them checked.
// Developer command, run by hand:
//
//   node packages/integration-catalog/scripts/probe-endpoint.mjs <url> [url...]
//   node packages/integration-catalog/scripts/probe-endpoint.mjs --catalog [id...]
//
// For each endpoint it sends one MCP `initialize` request without credentials
// and reads what comes back. On a 401 it follows the OAuth discovery chain the
// MCP authorization spec defines (protected-resource metadata, then the
// authorization server's metadata) and records whether the server lets a client
// register itself. It never registers a client, never starts a sign-in and
// never sends a token: an unwanted client left at a vendor is a real side
// effect, and the facts below are enough to decide the entry's `auth`.
//
// Verdicts, and what an entry does with them:
//   open           the server answered initialize without credentials → auth "none"
//                  (or "token" + tokenOptional when the vendor documents a key)
//   oauth          401 + an authorization server with a registration endpoint → auth "oauth"
//   oauth-cimd     401 + client ID metadata documents only → not one-click yet
//   registered-app 401 + an authorization server without self-registration → not suitable
//   token          401 without OAuth metadata → auth "token" with a documented header
//   refused        another 4xx/5xx → not suitable as listed
//   unreachable    DNS, TLS or timeout → not suitable as listed
//
// Output is one JSON object per endpoint, so a run can be diffed and pasted
// into an entry's `evidence`.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const CATALOG = fileURLToPath(new URL("../catalog/", import.meta.url));
const TIMEOUT_MS = 12_000;
const CONCURRENCY = 6;
const USER_AGENT = "polyth-integration-catalog-probe/1";

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "polyth-catalog-probe", version: "1" },
  },
});

async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(url) {
  try {
    const response = await request(url, { headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    const text = await response.text();
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `Bearer realm="x", resource_metadata="https://…"` → { resource_metadata: … }. */
function parseChallenge(header) {
  if (!header) return undefined;
  const scheme = header.trim().split(/\s+/)[0]?.toLowerCase();
  const params = {};
  for (const match of header.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  return { scheme, params };
}

/** RFC 9728 well-known locations for a resource URL, path-specific first. */
function resourceMetadataCandidates(url) {
  const target = new URL(url);
  const path = target.pathname.replace(/\/$/, "");
  const out = [];
  if (path) out.push(`${target.origin}/.well-known/oauth-protected-resource${path}`);
  out.push(`${target.origin}/.well-known/oauth-protected-resource`);
  return out;
}

/** RFC 8414 + OIDC discovery locations for an issuer. */
function authorizationServerCandidates(issuer) {
  const target = new URL(issuer);
  const path = target.pathname.replace(/\/$/, "");
  const out = [];
  if (path) {
    out.push(`${target.origin}/.well-known/oauth-authorization-server${path}`);
    out.push(`${target.origin}/.well-known/openid-configuration${path}`);
    out.push(`${target.origin}${path}/.well-known/openid-configuration`);
  }
  out.push(`${target.origin}/.well-known/oauth-authorization-server`);
  out.push(`${target.origin}/.well-known/openid-configuration`);
  return out;
}

async function firstJson(urls) {
  for (const url of urls) {
    const body = await readJson(url);
    if (body && typeof body === "object") return { url, body };
  }
  return undefined;
}

async function discoverOauth(url, challenge) {
  const declared = challenge?.params.resource_metadata;
  const resource = await firstJson(declared ? [declared, ...resourceMetadataCandidates(url)] : resourceMetadataCandidates(url));
  const issuers = Array.isArray(resource?.body.authorization_servers) ? resource.body.authorization_servers : [];
  // The 2025-03-26 spec let a server publish authorization metadata at its own
  // origin without protected-resource metadata; clients still fall back there.
  const issuer = issuers[0] ?? new URL(url).origin;
  const server = await firstJson(authorizationServerCandidates(issuer));
  if (!server) return { resourceMetadata: resource?.url, issuer: issuers[0] };
  return {
    resourceMetadata: resource?.url,
    issuer: server.body.issuer ?? issuer,
    registration: typeof server.body.registration_endpoint === "string" ? "dynamic"
      : server.body.client_id_metadata_document_supported === true ? "metadata-document"
        : "none",
    scopes: Array.isArray(server.body.scopes_supported) ? server.body.scopes_supported.slice(0, 12) : undefined,
  };
}

export async function probe(url) {
  const startedAt = new Date().toISOString().slice(0, 10);
  let response;
  try {
    response = await request(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: initialize,
    });
  } catch (cause) {
    return { url, checkedAt: startedAt, verdict: "unreachable", error: String(cause?.cause?.code ?? cause?.name ?? cause) };
  }
  const status = response.status;
  const header = response.headers.get("www-authenticate") ?? undefined;
  const challenge = parseChallenge(header);
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text().catch(() => "");
  const result = { url, checkedAt: startedAt, httpStatus: status, finalUrl: response.url !== url ? response.url : undefined };

  if (status >= 200 && status < 300) {
    const isMcp = /"jsonrpc"\s*:\s*"2\.0"/.test(body) && /"result"/.test(body);
    return { ...result, verdict: isMcp ? "open" : "refused", challenge: "none", note: isMcp ? undefined : `2xx without a JSON-RPC result (${contentType})` };
  }
  if (status === 401 || status === 403) {
    const oauth = await discoverOauth(url, challenge);
    const bearer = challenge?.scheme === "bearer";
    if (oauth.registration === "dynamic") return { ...result, verdict: "oauth", challenge: "bearer-oauth", oauth };
    if (oauth.registration === "metadata-document") return { ...result, verdict: "oauth-cimd", challenge: "bearer-oauth", oauth };
    if (oauth.registration === "none") return { ...result, verdict: "registered-app", challenge: "bearer-oauth", oauth };
    return { ...result, verdict: "token", challenge: bearer ? "bearer" : header ? "unknown" : "none", header: header?.slice(0, 200), body: body.slice(0, 200) };
  }
  return { ...result, verdict: "refused", challenge: header ? "unknown" : "none", body: body.slice(0, 200) };
}

async function catalogUrls(ids) {
  const names = ids.length > 0 ? ids : (await readdir(CATALOG, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const urls = [];
  for (const id of names) {
    const manifest = JSON.parse(await readFile(`${CATALOG}${id}/integration.json`, "utf8"));
    if (manifest.mcp?.remote?.url && !manifest.mcp.remote.url.includes("{")) urls.push({ id, url: manifest.mcp.remote.url });
  }
  return urls;
}

// Run as a command only; importing `probe` from another script stays silent.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const targets = args[0] === "--catalog"
    ? await catalogUrls(args.slice(1))
    : args.map((url) => ({ id: undefined, url }));
  if (targets.length === 0) {
    console.error("usage: probe-endpoint.mjs <url>… | --catalog [id…]");
    process.exitCode = 2;
  }
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next++];
      const outcome = await probe(target.url);
      console.log(JSON.stringify(target.id ? { id: target.id, ...outcome } : outcome));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
}
