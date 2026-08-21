import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import type { IncomingMessage } from "node:http";
import type { JsonObject } from "@polyth/contracts";

export interface OpenCodeClient {
  readonly baseUrl: string;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  /** DELETE (no body) — used for best-effort orphan branch cleanup. */
  del<T = unknown>(path: string): Promise<T>;
  streamEvents(
    signal: AbortSignal,
    onEvent: (evt: { id?: string; data: unknown }) => void,
  ): Promise<void>;
}

export interface OpenCodeClientOptions {
  headers?: Record<string, string>;
  directory?: string;
}

const authHeaders = (): Record<string, string> => {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const token = Buffer.from(`opencode:${password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
};

const withDirectory = (path: string, directory?: string): string => {
  if (!directory) return path;
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}directory=${encodeURIComponent(directory)}`;
};

/** undici fetch wraps every network failure in `TypeError: fetch failed`
 *  (cause: ECONNRESET / "other side closed" / "terminated"). These are
 *  transient — the serve process is alive but the pooled socket died —
 *  so REST calls retry; anything else propagates untouched. */
const isTransientNetworkError = (err: unknown): boolean => {
  if (err instanceof TypeError) return true;
  if (!(err instanceof Error)) return false;
  const text = `${err.message} ${String(err.cause ?? "")}`;
  return /fetch failed|terminated|ECONNRESET/i.test(text);
};

const abortError = (): Error => {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
};

/** Consume complete SSE frames from `buf`, invoke `onEvent` per frame, and
 *  return the unconsumed tail. Same frame grammar the fetch version parsed. */
const drainSseFrames = (
  buf: string,
  onEvent: (evt: { id?: string; data: unknown }) => void,
): string => {
  for (;;) {
    const sep = buf.indexOf("\n\n");
    if (sep < 0) return buf;
    const frame = buf.slice(0, sep);
    buf = buf.slice(sep + 2);
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join("\n");
    try {
      onEvent({ id, data: JSON.parse(raw) as JsonObject });
    } catch {
      onEvent({ id, data: raw });
    }
  }
};

export const createOpenCodeClient = (
  baseUrl: string,
  opts: OpenCodeClientOptions = {},
): OpenCodeClient => {
  const root = baseUrl.replace(/\/$/, "");
  const headers = { ...authHeaders(), ...opts.headers };

  const requestOnce = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const url = `${root}${withDirectory(path, opts.directory)}`;
    const res = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`opencode ${method} ${path} → ${res.status} ${text}`.slice(0, 500));
    }
    if (res.status === 204) return undefined as T;
    const raw = await res.text();
    if (!raw) return undefined as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  };

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const attempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await requestOnce<T>(method, path, body);
      } catch (err) {
        lastErr = err;
        if (attempt === attempts || !isTransientNetworkError(err)) throw err;
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
    throw lastErr;
  };

  return {
    baseUrl: root,
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body ?? {}),
    del: (path) => request("DELETE", path),
    // node:http, NOT fetch: undici aborts long-idle /event bodies
    // ("TypeError: terminated") and poisons the pooled connection, which then
    // fails later POSTs with "fetch failed".
    streamEvents(signal, onEvent) {
      const url = new URL(`${root}${withDirectory("/event", opts.directory)}`);
      const getFn = url.protocol === "https:" ? httpsGet : httpGet;
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (err) reject(err);
          else resolve();
        };
        const req = getFn(
          url,
          { headers: { ...headers, accept: "text/event-stream" } },
          (res: IncomingMessage) => {
            if (res.statusCode !== 200) {
              res.resume();
              req.destroy();
              settle(new Error(`opencode GET /event → ${res.statusCode ?? 0}`));
              return;
            }
            res.setEncoding("utf8");
            let buf = "";
            res.on("data", (chunk: string) => {
              buf += chunk;
              buf = buf.replace(/\r\n/g, "\n");
              buf = drainSseFrames(buf, onEvent);
            });
            res.on("end", () => settle());
            res.on("error", (err) => settle(err));
          },
        );
        const onAbort = () => {
          const err = abortError();
          req.destroy(err);
          settle(err);
        };
        req.on("error", (err) => settle(err));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
};
