import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import type {
  ProviderNetworkBroker,
  ProviderNetworkRequest,
  ProviderNetworkResponse,
  ProviderSecretBroker,
} from "@polyth/identity";
import type { ControlPlane } from "@polyth/control-plane";
import { createSecureSafeService } from "@polyth/secure-safe";

const MAX_BODY = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "user-agent",
  "x-github-api-version",
]);

type AddressClass = "public" | "private" | "blocked";

const ipv4Class = (value: string): AddressClass => {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return "blocked";
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) return "blocked";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
  return "public";
};

const addressClass = (value: string): AddressClass => {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.startsWith("::ffff:")) return ipv4Class(normalized.slice("::ffff:".length));
  const family = isIP(normalized);
  if (family === 4) return ipv4Class(normalized);
  if (family !== 6) return "blocked";
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe8") || normalized.startsWith("fe9")
    || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff")) return "blocked";
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return "private";
  return "public";
};

const providerAllowsPrivateNetwork = (control: ControlPlane, expectedIssuer: string): boolean => {
  const rows = control.all<{ public_config_json: string }>(
    "SELECT public_config_json FROM identity_providers WHERE issuer=? AND enabled=1",
    expectedIssuer,
  );
  return rows.some((row) => {
    try {
      const config = JSON.parse(row.public_config_json) as { privateNetworkApproved?: unknown };
      return config.privateNetworkApproved === true;
    } catch {
      return false;
    }
  });
};

const assertDestination = (expectedIssuer: string, request: ProviderNetworkRequest): URL => {
  const issuer = new URL(expectedIssuer);
  const url = new URL(request.url);
  if (issuer.protocol !== "https:" || url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw Object.assign(new Error("Identity provider transport must use HTTPS"), { code: "forbidden" });
  }
  const issuerOrigin = issuer.origin.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (issuerOrigin === "https://github.com") {
    if (url.port || (host !== "github.com" && host !== "api.github.com")) throw Object.assign(new Error("GitHub identity request escaped its allowlist"), { code: "forbidden" });
  } else if (issuerOrigin === "https://bitbucket.org") {
    if (url.port || (host !== "bitbucket.org" && host !== "api.bitbucket.org")) throw Object.assign(new Error("Bitbucket identity request escaped its allowlist"), { code: "forbidden" });
  } else if (url.origin.toLowerCase() !== issuer.origin.toLowerCase()) {
    throw Object.assign(new Error("Identity provider request escaped its configured issuer"), { code: "forbidden" });
  }
  return url;
};

export function createCanonicalProviderSecrets(dataDir: string): ProviderSecretBroker {
  const safe = createSecureSafeService({ dataDir: join(dataDir, "identity-provider-secrets") });
  return {
    async put(_purpose, secret) {
      const reference = `provider.${randomUUID()}`;
      safe.putOpaque(reference, secret);
      return reference;
    },
    async get(reference) {
      const value = safe.getOpaque(reference);
      if (!value) throw Object.assign(new Error("Identity provider secret is unavailable"), { code: "unavailable" });
      return value;
    },
    async delete(reference) {
      safe.deleteOpaque(reference);
    },
  };
}

export function createCanonicalProviderNetwork(control: ControlPlane): ProviderNetworkBroker {
  return {
    async request(_providerId, expectedIssuer, input): Promise<ProviderNetworkResponse> {
      const url = assertDestination(expectedIssuer, input);
      const body = input.body ?? "";
      if (Buffer.byteLength(body, "utf8") > MAX_BODY) throw Object.assign(new Error("Identity provider request body is too large"), { code: "invalid-input" });
      const resolved = await lookup(url.hostname, { all: true, verbatim: true });
      if (!resolved.length) throw Object.assign(new Error("Identity provider hostname did not resolve"), { code: "unavailable" });
      const allowPrivate = providerAllowsPrivateNetwork(control, expectedIssuer);
      for (const address of resolved) {
        const classification = addressClass(address.address);
        if (classification === "blocked" || (classification === "private" && !allowPrivate)) {
          throw Object.assign(new Error("Identity provider resolved to a disallowed network"), { code: "forbidden" });
        }
      }
      const selected = resolved[0]!;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.headers ?? {})) {
        const normalized = key.toLowerCase();
        if (!ALLOWED_HEADERS.has(normalized) || typeof value !== "string" || /[\r\n]/.test(value)) {
          throw Object.assign(new Error("Identity provider request header is not allowed"), { code: "invalid-input" });
        }
        headers[normalized] = value;
      }
      if (body) headers["content-length"] = String(Buffer.byteLength(body, "utf8"));
      const method = input.method ?? "GET";
      if (method !== "GET" && method !== "POST") throw Object.assign(new Error("Identity provider request method is not allowed"), { code: "invalid-input" });

      return await new Promise<ProviderNetworkResponse>((resolve, reject) => {
        const req = httpsRequest({
          protocol: "https:",
          hostname: url.hostname,
          port: url.port ? Number(url.port) : 443,
          path: `${url.pathname}${url.search}`,
          method,
          headers,
          servername: url.hostname,
          lookup: (_hostname, _options, callback) => {
            (callback as (error: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, selected.address, selected.family);
          },
        }, (response) => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            response.resume();
            reject(Object.assign(new Error("Identity provider redirects are not followed"), { code: "forbidden" }));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer | string) => {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += part.length;
            if (bytes > MAX_BODY) {
              response.destroy(Object.assign(new Error("Identity provider response is too large"), { code: "provider-unavailable" }));
              return;
            }
            chunks.push(part);
          });
          response.once("error", reject);
          response.once("end", () => {
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(response.headers)) {
              if (typeof value === "string") responseHeaders[key.toLowerCase()] = value;
              else if (Array.isArray(value)) responseHeaders[key.toLowerCase()] = value.join(", ");
            }
            resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks).toString("utf8") });
          });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(Object.assign(new Error("Identity provider request timed out"), { code: "provider-unavailable" })));
        req.once("error", reject);
        if (body) req.write(body);
        req.end();
      });
    },
  };
}
