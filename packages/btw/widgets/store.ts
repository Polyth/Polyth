// Ephemeral side-question threads, one per chat, in this tab's memory only:
// switching chats keeps a thread, closing its card forgets it, and nothing is
// ever written to the chat's history. Questions in one thread run in order so
// a follow-up sees the answer before it.
import { BTW_THREAD_MAX, type BtwRequest, type BtwResponse, type BtwThreadEntry } from "../src/shared.ts";

export type BtwEntryStatus = "pending" | "answered" | "failed";

export interface BtwEntry {
  id: string;
  question: string;
  status: BtwEntryStatus;
  answer?: string;
  error?: string;
}

export interface BtwThread {
  sessionId: string;
  entries: readonly BtwEntry[];
}

export interface BtwStoreDeps {
  ask(sessionId: string, request: BtwRequest, signal: AbortSignal): Promise<BtwResponse>;
  describeError(error: unknown): string;
}

interface ThreadRecord {
  thread: BtwThread;
  abort: AbortController;
  chain: Promise<void>;
}

export interface BtwStore {
  get(sessionId: string): BtwThread | undefined;
  subscribe(listener: () => void): () => void;
  /** Append a question; it runs after the thread's earlier ones settle. */
  ask(sessionId: string, question: string): void;
  /** Ask a failed question again, in place. */
  retry(sessionId: string, entryId: string): void;
  /** Forget the thread and drop any answer still on its way. */
  close(sessionId: string): void;
  /** Forget every thread (package disabled). */
  dispose(): void;
}

/** Answered questions before `entryId`, newest last, as the route's thread. */
export function threadBefore(entries: readonly BtwEntry[], entryId: string): BtwThreadEntry[] {
  const index = entries.findIndex((entry) => entry.id === entryId);
  return entries.slice(0, index < 0 ? entries.length : index)
    .filter((entry) => entry.status === "answered" && entry.answer)
    .map((entry) => ({ question: entry.question, answer: entry.answer! }))
    .slice(-BTW_THREAD_MAX);
}

export function createBtwStore(deps: BtwStoreDeps): BtwStore {
  const records = new Map<string, ThreadRecord>();
  const listeners = new Set<() => void>();
  let nextId = 0;
  const emit = () => { for (const listener of [...listeners]) listener(); };

  const update = (record: ThreadRecord, entryId: string, patch: Partial<BtwEntry>): void => {
    if (records.get(record.thread.sessionId) !== record) return;
    record.thread = {
      ...record.thread,
      entries: record.thread.entries.map((entry) => entry.id === entryId ? { ...entry, ...patch } : entry),
    };
    emit();
  };

  const run = (record: ThreadRecord, entryId: string): void => {
    record.chain = record.chain.then(async () => {
      if (records.get(record.thread.sessionId) !== record || record.abort.signal.aborted) return;
      const entry = record.thread.entries.find((candidate) => candidate.id === entryId);
      if (!entry) return;
      try {
        const response = await deps.ask(record.thread.sessionId, {
          question: entry.question,
          thread: threadBefore(record.thread.entries, entryId),
        }, record.abort.signal);
        update(record, entryId, { status: "answered", answer: response.answer, error: undefined });
      } catch (error) {
        if (record.abort.signal.aborted) return;
        update(record, entryId, { status: "failed", error: deps.describeError(error) });
      }
    });
  };

  return {
    get: (sessionId) => records.get(sessionId)?.thread,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    ask(sessionId, question) {
      const text = question.trim();
      if (!text) return;
      let record = records.get(sessionId);
      if (!record) {
        record = { thread: { sessionId, entries: [] }, abort: new AbortController(), chain: Promise.resolve() };
        records.set(sessionId, record);
      }
      const entry: BtwEntry = { id: `btw-${++nextId}`, question: text, status: "pending" };
      record.thread = { ...record.thread, entries: [...record.thread.entries, entry] };
      emit();
      run(record, entry.id);
    },
    retry(sessionId, entryId) {
      const record = records.get(sessionId);
      const entry = record?.thread.entries.find((candidate) => candidate.id === entryId);
      if (!record || entry?.status !== "failed") return;
      update(record, entryId, { status: "pending", error: undefined });
      run(record, entryId);
    },
    close(sessionId) {
      const record = records.get(sessionId);
      if (!record) return;
      record.abort.abort();
      records.delete(sessionId);
      emit();
    },
    dispose() {
      for (const record of records.values()) record.abort.abort();
      const had = records.size > 0;
      records.clear();
      if (had) emit();
      listeners.clear();
    },
  };
}
