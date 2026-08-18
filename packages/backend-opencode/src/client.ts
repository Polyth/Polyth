import type { JsonObject } from "@polyth/contracts";

export interface OpenCodeClient {
  readonly baseUrl: string;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
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

export const createOpenCodeClient = (
  baseUrl: string,
  opts: OpenCodeClientOptions = {},
): OpenCodeClient => {
  const root = baseUrl.replace(/\/$/, "");
  const headers = { ...authHeaders(), ...opts.headers };

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
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

  return {
    baseUrl: root,
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body ?? {}),
    async streamEvents(signal, onEvent) {
      const url = `${root}${withDirectory("/event", opts.directory)}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { ...headers, accept: "text/event-stream" },
        signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`opencode GET /event → ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        buf = buf.replace(/\r\n/g, "\n");
        for (;;) {
          const sep = buf.indexOf("\n\n");
          if (sep < 0) break;
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
      }
    },
  };
};
