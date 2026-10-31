// Turns the canonical events of one agent turn into what voice mode says and
// shows. Streamed `assistant/chunk` text is spoken sentence by sentence while
// it arrives; the final `assistant/message` only supplies whatever the stream
// did not (some harnesses never stream). Reasoning and tool activity are not
// the reply: they become status here, and spoken asides only through the
// opt-in narration (`narration.ts`).
import { createSpeakableStream, type SpeakableStream } from "@polyth/dictation";

export interface TrackedEvent {
  sessionId: string;
  seq: number;
  type: string;
  data: unknown;
}

export type ReplyActivity =
  | { kind: "thinking" }
  | { kind: "tool"; tool: string }
  | { kind: "needs-input" }
  | { kind: "done"; reason: "completed" | "aborted" | "error"; error?: string };

export interface ReplyUpdate {
  /** Speakable chunks, in order. */
  speak: string[];
  activity?: ReplyActivity;
}

export interface ReplyTrackerOptions {
  /** Spoken once per fenced code block (empty: skipped silently). */
  codePlaceholder?: string;
  tablePlaceholder?: string;
}

export interface ReplyTracker {
  accept(event: TrackedEvent): ReplyUpdate;
  /** Forget all parts (a new turn). */
  reset(): void;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const text = (data: unknown, key: string): string => {
  const value = record(data)[key];
  return typeof value === "string" ? value : "";
};

interface Part {
  stream: SpeakableStream;
  /** Raw streamed text so far, to find what a final message adds. */
  raw: string;
  finalized: boolean;
}

export function createReplyTracker(options: ReplyTrackerOptions = {}): ReplyTracker {
  let parts = new Map<string, Part>();
  // The first sentence of a reply starts speech immediately; later text
  // gathers into longer utterances so the voice does not stutter.
  const part = (id: string): Part => {
    let existing = parts.get(id);
    if (!existing) {
      existing = {
        stream: createSpeakableStream({
          minChars: 90,
          maxChars: 260,
          ...(options.codePlaceholder ? { codePlaceholder: options.codePlaceholder } : {}),
          ...(options.tablePlaceholder ? { tablePlaceholder: options.tablePlaceholder } : {}),
        }),
        raw: "",
        finalized: false,
      };
      parts.set(id, existing);
    }
    return existing;
  };

  const flushAll = (): string[] => {
    const out: string[] = [];
    for (const current of parts.values()) {
      if (current.finalized) continue;
      current.finalized = true;
      out.push(...current.stream.flush());
    }
    return out;
  };

  return {
    accept(event) {
      switch (event.type) {
        case "turn/started":
          return { speak: [], activity: { kind: "thinking" } };
        case "assistant/chunk": {
          const id = text(event.data, "partId");
          const current = part(id);
          if (current.finalized) return { speak: [] };
          const delta = text(event.data, "text");
          current.raw += delta;
          return { speak: current.stream.push(delta) };
        }
        case "assistant/message": {
          const id = text(event.data, "partId");
          const current = part(id);
          if (current.finalized) return { speak: [] };
          const final = text(event.data, "text");
          const speak: string[] = [];
          // Only the unstreamed tail is new. A final text that disagrees with
          // what was streamed (a provider rewrite) is not re-read from the top.
          if (final.startsWith(current.raw)) speak.push(...current.stream.push(final.slice(current.raw.length)));
          current.raw = final;
          current.finalized = true;
          speak.push(...current.stream.flush());
          return { speak };
        }
        case "tool/call":
        case "tool/started": {
          const tool = text(event.data, "tool");
          // A tool call ends the text before it: speak that text now rather
          // than holding its last sentence until the turn ends.
          return { speak: flushAll(), activity: { kind: "tool", tool } };
        }
        case "permission/requested":
        case "question/asked":
        case "secret/requested":
          return { speak: flushAll(), activity: { kind: "needs-input" } };
        case "turn/stopped": {
          const raw = text(event.data, "reason");
          const reason = raw === "aborted" || raw === "error" ? raw : "completed";
          const error = text(event.data, "error");
          return {
            speak: flushAll(),
            activity: { kind: "done", reason, ...(error ? { error } : {}) },
          };
        }
        default:
          return { speak: [] };
      }
    },
    reset() {
      parts = new Map();
    },
  };
}

/** Compare a spoken transcript with a canonical user message: whitespace and
 *  case differences from composer normalization do not matter. */
export function sameUtterance(spoken: string, message: string): boolean {
  const norm = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const a = norm(spoken);
  const b = norm(message);
  return a.length > 0 && (b === a || b.endsWith(a) || b.includes(a));
}
