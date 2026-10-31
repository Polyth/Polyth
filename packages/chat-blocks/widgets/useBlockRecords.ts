// Loads a block's `from=` file through the Files API (Space-scoped, confined
// to the session's checkout) and parses it. Reads are cached per file so a
// block that remounts while scrolling does not refetch; Refresh re-reads.
import { useEffect, useState } from "react";
import { ApiError, createApiTransport, type MarkdownFenceContext } from "@polyth/web-sdk";
import { parseRecords } from "../src/records.ts";
import type { DataRecord } from "../src/parse.ts";

export type RecordsError = "no-project" | "not-found" | "too-large" | "format" | "empty" | "unavailable";

export type RecordsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; records: DataRecord[]; total: number; truncated: boolean }
  | { status: "error"; error: RecordsError };

type Loaded = Exclude<RecordsState, { status: "idle" | "loading" }>;

export interface FileRead {
  content?: string;
  truncated?: boolean;
  tooLarge?: boolean;
}

const CACHE_LIMIT = 24;
const cache = new Map<string, Promise<Loaded>>();
let transport = createApiTransport();

/** Tests swap the network. */
export function setRecordsTransportForTests(fetchImpl: typeof fetch | null): void {
  transport = createApiTransport(fetchImpl ? { fetch: fetchImpl, readRetry: false } : {});
  cache.clear();
}

/** One project file through the Files API (Space-scoped, session checkout). */
export async function readProjectFile(
  path: string,
  projectId: string,
  sessionId: string | null | undefined,
): Promise<{ file: FileRead } | { error: "not-found" | "unavailable" }> {
  const query = new URLSearchParams({ projectId, path });
  if (sessionId) query.set("sessionId", sessionId);
  try {
    return { file: await transport.get<FileRead>(`/api/files/read?${query.toString()}`) };
  } catch (cause) {
    return { error: cause instanceof ApiError && cause.status === 404 ? "not-found" : "unavailable" };
  }
}

async function load(path: string, projectId: string, sessionId: string | null | undefined): Promise<Loaded> {
  const read = await readProjectFile(path, projectId, sessionId);
  if ("error" in read) return { status: "error", error: read.error };
  const file = read.file;
  if (file.tooLarge) return { status: "error", error: "too-large" };
  const parsed = parseRecords(path, file.content ?? "", file.truncated === true);
  if (!parsed.ok) return { status: "error", error: parsed.reason };
  return { status: "ready", records: parsed.records, total: parsed.total, truncated: parsed.truncated };
}

export function useBlockRecords(
  source: string | undefined,
  context: Pick<MarkdownFenceContext, "projectId" | "sessionId">,
  enabled: boolean,
): { state: RecordsState; reload(): void } {
  const [state, setState] = useState<RecordsState>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  const { projectId, sessionId } = context;
  const key = source && projectId ? `${projectId}\u0000${sessionId ?? ""}\u0000${source}` : "";

  useEffect(() => {
    if (!enabled || !source) {
      setState({ status: "idle" });
      return;
    }
    if (!projectId) {
      setState({ status: "error", error: "no-project" });
      return;
    }
    let promise = cache.get(key);
    if (!promise) {
      promise = load(source, projectId, sessionId);
      cache.set(key, promise);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      // A failed read is retried next time instead of being remembered.
      void promise.then((result) => { if (result.status === "error") cache.delete(key); });
    }
    let live = true;
    setState({ status: "loading" });
    void promise.then((result) => { if (live) setState(result); });
    return () => { live = false; };
  }, [enabled, source, projectId, sessionId, key, nonce]);

  return {
    state,
    reload: () => {
      cache.delete(key);
      setNonce((value) => value + 1);
    },
  };
}
