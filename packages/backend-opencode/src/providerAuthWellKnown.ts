import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { WellKnownPreviewDto } from "@polyth/contracts";
import { authError, throwAuthError } from "@polyth/models/auth";
import {
  hashWellKnownPayload,
  MAX_WELLKNOWN_BYTES,
  normalizeOrigin,
  validateWellKnownDocument,
  wellKnownUrl,
} from "@polyth/models/auth/well-known";
import { fetchPinnedHttp, inspectOutboundHttpUrl, type Resolver } from "./outboundUrl.ts";
import {
  sameAuthTarget,
  type OpenCodeAuthTarget,
  type WellKnownExecutionLocality,
} from "./providerAuthTarget.ts";

const PREVIEW_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_TOKEN_STDOUT_BYTES = 16_384;
const MAX_DIAGNOSTIC_STDERR_BYTES = 8_192;
const MAX_REDIRECTS = 3;

export interface WellKnownPin {
  origin: string;
  command: string[];
  env: string;
  hash: string;
  at: number;
  used: boolean;
  spaceId: string;
  authorityId: string;
  generation: number;
  executionLocality: WellKnownExecutionLocality;
}

const MINIMAL_ENV_KEYS = [
  "PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
] as const;

const minimalEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { TERM: "dumb" };
  for (const key of MINIMAL_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
};

export interface BoundedSpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutOverflow: boolean;
  stderrOverflow: boolean;
}

/**
 * Spawn is abortable via `signal`, but provider-auth HTTP/UI has no cancel
 * route for well-known execute. Disconnecting the browser does not abort the
 * child; the command runs until exit or COMMAND_TIMEOUT_MS.
 */
export const runPinnedArgv = async (input: {
  argv: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxStdout?: number;
  maxStderr?: number;
}): Promise<BoundedSpawnResult> => {
  const argv = [...input.argv];
  if (!argv[0]) throw authError("AUTH_WELLKNOWN_UNSAFE", { details: "empty command" });
  const maxStdout = input.maxStdout ?? MAX_TOKEN_STDOUT_BYTES;
  const maxStderr = input.maxStderr ?? MAX_DIAGNOSTIC_STDERR_BYTES;
  return new Promise((resolve, reject) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrOverflow = false;
    const child = spawn(argv[0]!, argv.slice(1), {
      shell: false,
      cwd: input.cwd ?? homedir(),
      env: input.env ?? minimalEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    const finish = (result: BoundedSpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(error);
    };
    const onAbort = () => fail(Object.assign(new Error("command aborted"), { code: "AUTH_CANCELLED" }));
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      fail(Object.assign(new Error("command timed out"), { code: "AUTH_EXPIRED" }));
    }, input.timeoutMs ?? COMMAND_TIMEOUT_MS);
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutOverflow) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdout) {
        stdoutOverflow = true;
        stdoutChunks.push(chunk.subarray(0, Math.max(0, maxStdout - (stdoutBytes - chunk.byteLength))));
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrOverflow) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxStderr) {
        stderrOverflow = true;
        stderrChunks.push(chunk.subarray(0, Math.max(0, maxStderr - (stderrBytes - chunk.byteLength))));
        return;
      }
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => fail(error));
    child.on("close", (code, signal) => {
      finish({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        stdoutOverflow,
        stderrOverflow,
      });
    });
  });
};

export const readBoundedJson = async (
  response: Response,
): Promise<{ payload: unknown; contentType: string | undefined }> => {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_WELLKNOWN_BYTES) {
    await response.body?.cancel().catch(() => {});
    return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: "response too large" }));
  }
  const reader = response.body?.getReader();
  if (!reader) return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: "empty body" }));
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_WELLKNOWN_BYTES) {
        await reader.cancel().catch(() => {});
        return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: "response too large" }));
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return {
      payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  } catch {
    return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: "non-JSON body" }));
  }
};

export const createWellKnownFlow = (deps: {
  now: () => number;
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
  pins?: Map<string, WellKnownPin>;
}) => {
  const pins = deps.pins ?? new Map<string, WellKnownPin>();

  /** Content hash is not a review handle: the same document can be reviewed
   *  independently per Space and authority. Generation stays inside the pin
   *  so a generation mismatch is "target changed", not "not reviewed". */
  const pinKey = (spaceId: string, authorityId: string, hash: string): string =>
    `${spaceId}\0${authorityId}\0${hash}`;

  const sweep = (): void => {
    const cutoff = deps.now() - PREVIEW_TTL_MS;
    for (const [key, pin] of pins) {
      if (pin.used || pin.at < cutoff) pins.delete(key);
    }
  };

  const hop = async (
    inspected: { url: URL; addresses: string[] },
    signal: AbortSignal,
  ): Promise<Response> => {
    const headers = { accept: "application/json" };
    if (deps.fetchImpl) {
      return deps.fetchImpl(inspected.url.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers,
      });
    }
    return fetchPinnedHttp(inspected.url, inspected.addresses, { method: "GET", signal, headers });
  };

  const preview = async (originInput: string, target: OpenCodeAuthTarget): Promise<WellKnownPreviewDto> => {
    sweep();
    const origin = normalizeOrigin(originInput);
    if (!origin) return throwAuthError(authError("AUTH_INPUT_INVALID", { field: "origin" }));
    const discoveryUrl = wellKnownUrl(origin);
    const inspectOpts = { policy: "user-origin" as const, ...(deps.resolve ? { resolve: deps.resolve } : {}) };
    const first = await inspectOutboundHttpUrl(discoveryUrl, inspectOpts);
    if (!first.ok) return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: first.reason }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let currentUrl = first.url.toString();
      let current = await hop(first, controller.signal);
      for (let hops = 0; hops < MAX_REDIRECTS && current.status >= 300 && current.status < 400; hops += 1) {
        const location = current.headers.get("location");
        if (!location) break;
        await current.body?.cancel().catch(() => {});
        const nextRaw = new URL(location, currentUrl).toString();
        const next = await inspectOutboundHttpUrl(nextRaw, inspectOpts);
        if (!next.ok) return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: next.reason }));
        currentUrl = next.url.toString();
        current = await hop(next, controller.signal);
      }
      if (current.status >= 300 && current.status < 400) {
        await current.body?.cancel().catch(() => {});
        return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: "too many redirects" }));
      }
      const { payload, contentType } = await readBoundedJson(current);
      const validated = validateWellKnownDocument(origin, payload, contentType, current.status);
      if (!validated.ok) return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: validated.reason }));
      pins.set(pinKey(target.spaceId, target.authorityId, validated.document.hash), {
        origin,
        command: validated.document.command,
        env: validated.document.env,
        hash: validated.document.hash,
        at: deps.now(),
        used: false,
        spaceId: target.spaceId,
        authorityId: target.authorityId,
        generation: target.generation,
        executionLocality: target.executionLocality,
      });
      return {
        origin,
        hash: validated.document.hash,
        command: validated.document.command,
        env: validated.document.env,
      };
    } catch (caught) {
      if ((caught as { code?: string }).code?.startsWith("AUTH_")) throw caught;
      return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: "discovery failed" }));
    } finally {
      clearTimeout(timer);
    }
  };

  const takePin = (originInput: string, hash: string, target: OpenCodeAuthTarget): WellKnownPin => {
    sweep();
    const origin = normalizeOrigin(originInput);
    if (!origin || !hash) return throwAuthError(authError("AUTH_INPUT_INVALID"));
    const key = pinKey(target.spaceId, target.authorityId, hash);
    const pin = pins.get(key);
    if (!pin || pin.origin !== origin) {
      return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: "document was not reviewed" }));
    }
    if (pin.used) return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: "review already used" }));
    if (deps.now() - pin.at > PREVIEW_TTL_MS) {
      pins.delete(key);
      return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: "review expired" }));
    }
    if (hashWellKnownPayload({ origin: pin.origin, command: pin.command, env: pin.env }) !== hash) {
      pins.delete(key);
      return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: "document hash mismatch" }));
    }
    const pinnedTarget: OpenCodeAuthTarget = {
      spaceId: pin.spaceId,
      authorityId: pin.authorityId,
      generation: pin.generation,
      executionLocality: pin.executionLocality,
    };
    // Throw before consuming: a wrong-target lookup must not burn another
    // Space/authority's valid review.
    if (!sameAuthTarget(pinnedTarget, target) || pin.executionLocality !== "local-process") {
      return throwAuthError(authError("AUTH_WELLKNOWN_UNSAFE", { details: "auth target changed since review" }));
    }
    pin.used = true;
    pins.delete(key);
    return pin;
  };

  return { preview, takePin, pins, sweep, runPinnedArgv };
};
