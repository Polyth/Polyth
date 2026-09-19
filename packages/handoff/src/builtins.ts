import type { JsonObject, SessionEvent, SpaceContext, SessionService } from "@polyth/contracts";
import { estimateTokens } from "./tokens.ts";
import { hashText } from "./hash.ts";
import type { ContextSourceProvider } from "./index.ts";

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export function createBuiltinSources(deps: {
  sessionsFor: (space: SpaceContext) => SessionService;
}): ContextSourceProvider[] {
  const task: ContextSourceProvider = {
    id: "task",
    label: "Task",
    description: "Latest user prompt in the session",
    defaultOn: true,
    async collect(ctx) {
      const events = await deps.sessionsFor(ctx.space).events(ctx.sessionId);
      const users = events.filter((e) => e.type === "user/message");
      const last = users.at(-1);
      const text = last ? String((last.data as { text?: string }).text ?? "") : "";
      if (!text.trim()) return { sections: [], status: "missing" };
      return {
        sections: [{ title: "Task", body: text, fingerprint: hashText(text), tokens: estimateTokens(text) }],
        status: "ok",
      };
    },
  };

  const sessionSummary: ContextSourceProvider = {
    id: "session-summary",
    label: "Session summary",
    description: "Compact digest of session state (not full transcript)",
    defaultOn: true,
    async collect(ctx) {
      const sessions = deps.sessionsFor(ctx.space);
      const projection = await sessions.snapshot(ctx.sessionId);
      const events = await sessions.events(ctx.sessionId);
      const userCount = events.filter((e) => e.type === "user/message").length;
      const assistantCount = events.filter((e) => e.type === "assistant/message").length;
      const recent = events.slice(-6).map((e) => summarizeEvent(e)).filter(Boolean);
      const body = [
        `# Session summary`,
        `Title: ${projection.title}`,
        `Harness/model: ${projection.harness ?? projection.agent ?? "default"} / ${projection.model?.providerID ?? "?"}:${projection.model?.modelID ?? "?"}`,
        `Status: ${projection.status}`,
        `Messages: ${userCount} user, ${assistantCount} assistant`,
        "",
        "## Recent turns [digest]",
        ...recent,
      ].join("\n");
      return {
        sections: [{
          title: "Current state",
          body,
          fingerprint: hashText(body),
          tokens: estimateTokens(body),
        }],
        status: "ok",
      };
    },
  };

  const sessionErrors: ContextSourceProvider = {
    id: "session-errors",
    label: "Logs",
    description: "Recent tool/runtime errors from the session log",
    defaultOn: true,
    async collect(ctx) {
      const events = await deps.sessionsFor(ctx.space).events(ctx.sessionId);
      const errors = events.filter((e) => e.type === "tool/error" || e.type === "runtime/error").slice(-20);
      if (errors.length === 0) return { sections: [], status: "missing" };
      const body = errors.map((e) => `- ${e.type}: ${JSON.stringify(e.data).slice(0, 400)}`).join("\n");
      return {
        sections: [{ title: "Logs", body, fingerprint: hashText(body), tokens: estimateTokens(body) }],
        status: "ok",
      };
    },
  };

  const note: ContextSourceProvider = {
    id: "note",
    label: "Custom note",
    description: "Freeform note supplied when building the bundle",
    async collect(ctx) {
      const text = String(ctx.params?.text ?? "");
      if (!text.trim()) return { sections: [], status: "missing" };
      return {
        sections: [{ title: "Note", body: text, fingerprint: hashText(text), tokens: estimateTokens(text) }],
        status: "ok",
      };
    },
  };

  return [task, sessionSummary, sessionErrors, note];
}

function summarizeEvent(event: SessionEvent): string {
  if (event.type === "user/message") {
    const text = String((event.data as { text?: string }).text ?? "").replace(/\s+/g, " ").slice(0, 200);
    return `- user: ${text}${text.length >= 200 ? "…" : ""} [digest]`;
  }
  if (event.type === "assistant/message") {
    const text = String((event.data as { text?: string }).text ?? "").replace(/\s+/g, " ").slice(0, 200);
    return `- assistant: ${text}${text.length >= 200 ? "…" : ""} [digest]`;
  }
  return "";
}

export interface StoredBundle {
  id: string;
  projectId: string;
  sessionId: string;
  presetId: string;
  label: string;
  instruction: string;
  sources: Array<{ id: string; params?: JsonObject; tokens: number; fingerprint: string; status: "ok" | "missing" | "error"; error?: string }>;
  markdown: string;
  tokens: number;
  createdAt: number;
  fingerprints: Record<string, string>;
  warning?: { tokens: number; largestSources: Array<{ id: string; label: string; tokens: number }> };
}

export { renderBundleMarkdown } from "./bundleRender.ts";
export { err };
