// Human rendering of canonical session events for `log`, `chat`, `new --wait`.
// Streaming text is written as it arrives; tools collapse to one line.
import { oneLine, style, truncate, type Output } from "./output.ts";
import type { SessionEvent } from "./api.ts";

export interface RenderOptions {
  reasoning?: boolean;
  /** Show user messages (off in chat, where the person just typed them). */
  userMessages?: boolean;
  /** Show tool calls. */
  tools?: boolean;
}

export interface TurnOutcome {
  reason: string;
  error?: string;
}

/** Stateful: tracks which assistant parts were streamed so a final
 *  `assistant/message` does not print the same text twice. */
export function createRenderer(o: Output, opts: RenderOptions = {}) {
  const streamed = new Set<string>();
  let atLineStart = true;
  let lastAssistantText = "";
  let currentPart: string | undefined;
  let mode: "text" | "reasoning" | undefined;

  const ensureNewline = () => {
    if (!atLineStart) { o.write("\n"); atLineStart = true; }
  };
  const writeText = (text: string, dim = false) => {
    if (!text) return;
    o.write(dim ? style.dim(o.color, text) : text);
    atLineStart = text.endsWith("\n");
  };
  const line = (text: string) => {
    ensureNewline();
    o.out(text);
    atLineStart = true;
  };

  const toolSummary = (data: Record<string, unknown>): string => {
    const tool = String(data.tool ?? data.name ?? "tool");
    const input = (data.input && typeof data.input === "object" ? data.input : {}) as Record<string, unknown>;
    const detail = input.command ?? input.description ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.prompt;
    return detail === undefined ? tool : `${tool}  ${style.dim(o.color, truncate(oneLine(detail), Math.max(20, o.width - tool.length - 6)))}`;
  };

  return {
    get lastAssistantText(): string { return lastAssistantText; },
    finish(): void { ensureNewline(); },
    /** Render one event; returns the turn outcome when this event ends a turn. */
    event(event: SessionEvent): TurnOutcome | undefined {
      const d = event.data ?? {};
      switch (event.type) {
        case "user/message": {
          if (opts.userMessages === false) return undefined;
          if (d.hidden === true) return undefined;
          line(`${style.bold(o.color, style.blue(o.color, "›"))} ${String(d.text ?? "")}`);
          return undefined;
        }
        case "assistant/chunk": {
          const part = String(d.partId ?? "");
          if (part !== currentPart || mode !== "text") {
            if (mode === "reasoning") ensureNewline();
            currentPart = part;
            mode = "text";
            lastAssistantText = "";
          }
          streamed.add(part);
          const text = String(d.text ?? "");
          lastAssistantText += text;
          writeText(text);
          return undefined;
        }
        case "assistant/reasoning-chunk": {
          if (!opts.reasoning) return undefined;
          if (mode !== "reasoning") { ensureNewline(); mode = "reasoning"; }
          writeText(String(d.text ?? ""), true);
          return undefined;
        }
        case "assistant/message": {
          const part = String(d.partId ?? "");
          const text = String(d.text ?? "");
          if (text && !streamed.has(part)) {
            ensureNewline();
            writeText(text);
            lastAssistantText = text;
          }
          return undefined;
        }
        case "tool/started": {
          if (opts.tools === false) return undefined;
          line(style.gray(o.color, `⚙ ${toolSummary(d)}`));
          mode = undefined;
          return undefined;
        }
        case "tool/error": {
          if (opts.tools === false) return undefined;
          line(style.red(o.color, `✗ ${String(d.tool ?? "tool")}: ${truncate(oneLine(d.error ?? "failed"), o.width - 10)}`));
          return undefined;
        }
        case "permission/requested": {
          line(style.yellow(o.color, `⚠ permission needed: ${String(d.permission ?? "action")} — ${truncate(oneLine((d.patterns as unknown[] | undefined)?.join(" ") ?? ""), o.width - 30)}`));
          line(style.dim(o.color, `  answer in the Polyth UI (polyth open ${event.sessionId.slice(0, 8)})`));
          return undefined;
        }
        case "question/asked": {
          const first = (Array.isArray(d.questions) ? d.questions[0] : undefined) as Record<string, unknown> | undefined;
          line(style.yellow(o.color, `? ${String(first?.title ?? "question")}: ${oneLine(first?.prompt ?? "")}`));
          line(style.dim(o.color, `  reply: polyth requests answer ${event.sessionId.slice(0, 8)} ${String(d.requestId ?? "")} <answer>`));
          return undefined;
        }
        case "turn/stopped": {
          ensureNewline();
          const reason = String(d.reason ?? "completed");
          const error = d.error && typeof d.error === "object" ? String((d.error as Record<string, unknown>).message ?? "") : d.message ? String(d.message) : "";
          if (reason === "error") line(style.red(o.color, `✗ turn failed${error ? `: ${error}` : ""}`));
          else if (reason === "aborted") line(style.yellow(o.color, "■ stopped"));
          mode = undefined;
          return { reason, ...(error ? { error } : {}) };
        }
        default:
          return undefined;
      }
    },
  };
}
