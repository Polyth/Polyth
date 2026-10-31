import { randomUUID } from "node:crypto";
import { bool, int, seconds, str, UsageError, type FlagSpec } from "../args.ts";
import {
  highWater, listProjects, modelRef, openRequests, operationIdFor, resolveProject, resolveSessionId, session, summaries, tail,
  type SessionEvent, type SessionSummary,
} from "../api.ts";
import { PolythError, type Client } from "../client.ts";
import type { Command, Context } from "../context.ts";
import { followSession } from "../follow.ts";
import { ago, oneLine, statusColor, style, table, truncate, type Output } from "../output.ts";
import { createRenderer, type TurnOutcome } from "../render.ts";
import { textArg } from "../system.ts";

const enc = encodeURIComponent;
const ACTIVE = new Set(["working", "reconciling", "waiting"]);

export const attentionBadge = (o: Output, s: SessionSummary): string => {
  const a = s.attention;
  if (!a) return "";
  const parts: string[] = [];
  if (a.permissions) parts.push(style.yellow(o.color, `⚠${a.permissions}`));
  if (a.questions) parts.push(style.yellow(o.color, `?${a.questions}`));
  return parts.join(" ");
};

export const sessions: Command = {
  name: "sessions",
  aliases: ["ls"],
  summary: "List recent sessions",
  usage: "polyth sessions [-p PROJECT | --all] [--archived] [--attention] [-q TEXT] [-n N]",
  flags: [
    { name: "project", short: "p", value: true, description: "Project id, name or path (default: the one containing this directory)" },
    { name: "all", short: "a", description: "Every project" },
    { name: "archived", description: "Archived sessions instead" },
    { name: "attention", description: "Only sessions waiting for you" },
    { name: "query", short: "q", value: true, description: "Search titles" },
    { name: "limit", short: "n", value: true, description: "How many (default 20)" },
  ],
  async run(ctx, args) {
    const client = ctx.client();
    const projects = await listProjects(client);
    const project = bool(args, "all") ? undefined : await resolveProject(client, str(args, "project")).catch((error) => {
      if (str(args, "project")) throw error;
      return undefined; // Outside any project: show everything.
    });
    const page = await summaries(client, {
      ...(project ? { projectId: project.id } : {}),
      limit: int(args, "limit", 20, 1, 200),
      archived: bool(args, "archived"),
      attentionOnly: bool(args, "attention"),
      ...(str(args, "query") ? { query: str(args, "query")! } : {}),
    });
    if (ctx.o.json) { ctx.o.data(page.sessions); return; }
    const o = ctx.o;
    if (!page.sessions.length) { o.err("No sessions."); return; }
    const names = new Map(projects.map((p) => [p.id, p.name]));
    table(o, project ? ["ID", "STATUS", "UPDATED", "", "TITLE"] : ["ID", "STATUS", "UPDATED", "", "PROJECT", "TITLE"],
      page.sessions.map((s) => [
        style.dim(o.color, s.id.slice(0, 8)),
        statusColor(o, s.status),
        ago(s.updatedAt),
        attentionBadge(o, s),
        ...(project ? [] : [names.get(s.projectId) ?? s.projectId.slice(0, 8)]),
        s.title ?? style.dim(o.color, "(untitled)"),
      ]));
  },
};

export const show: Command = {
  name: "show",
  summary: "Show one session: status, model, open requests, last reply",
  usage: "polyth show SESSION",
  async run(ctx, args) {
    const client = ctx.client();
    const id = await resolveSessionId(client, args.positionals[0]);
    const [s, events] = await Promise.all([session(client, id), tail(client, id, 400)]);
    const requests = openRequests(events);
    const lastReply = [...events].reverse().find((e) => e.type === "assistant/message" && String(e.data.text ?? "").trim());
    if (ctx.o.json) { ctx.o.data({ ...s, openRequests: requests, lastReply: lastReply?.data.text ?? null }); return; }
    const o = ctx.o;
    const row = (k: string, v: string) => o.out(`${style.bold(o.color, k.padEnd(10))} ${v}`);
    row("Session", s.id);
    row("Title", String(s.title ?? "(untitled)"));
    row("Status", `${statusColor(o, s.status)} ${attentionBadge(o, s)}`);
    row("Project", s.projectId);
    if (s.model) row("Model", `${s.model.providerID}/${s.model.modelID}${s.resolvedHarnessId ? ` via ${s.resolvedHarnessId}` : ""}`);
    if (s.branch) row("Branch", String(s.branch));
    if (s.worktreePath) row("Worktree", String(s.worktreePath));
    row("Updated", ago(s.updatedAt));
    for (const r of requests) {
      o.out(style.yellow(o.color, `\n${r.kind === "permission" ? "⚠ permission" : "? question"} ${r.requestId}: ${r.title}`));
      if (r.detail) o.out(`  ${truncate(oneLine(r.detail), o.width - 2)}`);
      if (r.options) o.out(style.dim(o.color, `  options: ${r.options.map((x) => x.label).join(" | ")}`));
    }
    if (lastReply) o.out(`\n${style.dim(o.color, "Last reply:")}\n${String(lastReply.data.text)}`);
  },
};

const logFlags: FlagSpec[] = [
  { name: "follow", short: "f", description: "Keep streaming new events" },
  { name: "limit", short: "n", value: true, description: "How many recent events to start from (default 300)" },
  { name: "since", value: true, description: "Start after this event sequence number" },
  { name: "reasoning", description: "Include model reasoning" },
  { name: "raw", description: "One JSON event per line (same as --json)" },
];

export const log: Command = {
  name: "log",
  aliases: ["logs", "tail"],
  summary: "Print a session's conversation; -f streams it live",
  usage: "polyth log SESSION [-f] [-n N | --since SEQ] [--reasoning] [--raw]",
  flags: logFlags,
  async run(ctx, args) {
    const client = ctx.client();
    const id = await resolveSessionId(client, args.positionals[0]);
    const raw = ctx.o.json || bool(args, "raw");
    const renderer = createRenderer(ctx.o, { reasoning: bool(args, "reasoning") });
    const emit = (event: SessionEvent) => raw ? ctx.o.out(JSON.stringify(event)) : void renderer.event(event);
    let cursor: number;
    const since = str(args, "since");
    if (since !== undefined) cursor = int(args, "since", 0);
    else {
      const recent = await tail(client, id, int(args, "limit", 300, 1, 5000));
      for (const event of recent) emit(event);
      cursor = recent.at(-1)?.seq ?? 0;
    }
    if (!bool(args, "follow")) {
      if (since !== undefined) {
        // One forward page set from --since, then stop.
        const controller = new AbortController();
        const hw = await highWater(client, id);
        if (cursor < hw) for await (const event of followSession(client, id, cursor, controller.signal)) {
          emit(event);
          if (event.seq >= hw) break;
        }
      }
      renderer.finish();
      return;
    }
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    for await (const event of followSession(client, id, cursor, controller.signal)) emit(event);
    renderer.finish();
    return 0;
  },
};

/** Stream (or silently await) the turn our message starts. Resolves when
 *  the first turn that begins at/after our user message stops. */
export async function awaitTurn(
  ctx: Context,
  client: Client,
  sessionId: string,
  afterSeq: number,
  opts: { render: boolean; timeoutSec: number; reasoning?: boolean },
): Promise<{ outcome: TurnOutcome; text: string }> {
  const controller = new AbortController();
  const timer = opts.timeoutSec > 0 ? setTimeout(() => controller.abort(new Error("timeout")), opts.timeoutSec * 1000) : undefined;
  const onSigint = () => controller.abort(new Error("interrupted"));
  process.once("SIGINT", onSigint);
  const renderer = createRenderer(ctx.o, { userMessages: false, reasoning: opts.reasoning === true });
  const silent = createRenderer({ ...ctx.o, write() {}, out() {}, err() {} }, {});
  let sawUser = false;
  try {
    for await (const event of followSession(client, sessionId, afterSeq, controller.signal)) {
      if (event.type === "user/message") sawUser = true;
      const outcome = (opts.render ? renderer : silent).event(event);
      if (outcome && sawUser) {
        renderer.finish();
        return { outcome, text: (opts.render ? renderer : silent).lastAssistantText };
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGINT", onSigint);
  }
  renderer.finish();
  const reason = (controller.signal.reason as Error | undefined)?.message;
  if (reason === "interrupted") {
    ctx.o.err(style.yellow(ctx.o.color, `\nDetached; the turn keeps running. Stop it with: polyth stop ${sessionId.slice(0, 8)}`));
    throw Object.assign(new Error("interrupted"), { code: "interrupted" });
  }
  throw Object.assign(new Error(`timed out waiting for session ${sessionId.slice(0, 8)}`), { code: "timeout" });
}

const sendFlags: FlagSpec[] = [
  { name: "wait", short: "w", description: "Wait for the reply (streams it; with --json prints the final result)" },
  { name: "timeout", value: true, description: "With --wait: give up after this long (e.g. 10m). Default: no limit" },
  { name: "model", short: "m", value: true, description: "provider/model for this message" },
  { name: "idempotency-key", value: true, description: "Retrying with the same key never sends twice" },
  { name: "reasoning", description: "With --wait: show model reasoning" },
];

async function sendAndMaybeWait(
  ctx: Context, client: Client, sessionId: string, text: string,
  args: Parameters<Command["run"]>[1], delivery: string | undefined, extra: Record<string, unknown> = {},
): Promise<number> {
  const before = await highWater(client, sessionId);
  const key = str(args, "idempotency-key");
  const clientOperationId = key ? await operationIdFor(`send\0${sessionId}\0${key}`) : randomUUID();
  const model = modelRef(str(args, "model"));
  let result: Record<string, unknown>;
  try {
    result = await client.post<Record<string, unknown>>(`/api/sessions/${enc(sessionId)}/message`, {
      text, clientOperationId, ...(delivery ? { delivery } : {}), ...(model ? { model } : {}), ...extra,
    });
  } catch (error) {
    // The server could not confirm delivery and reconciles it itself; never
    // resend blindly. With --wait, keep following what actually happened.
    if (!(error instanceof PolythError) || error.code !== "outcome-unknown") throw error;
    if (!bool(args, "wait")) {
      throw new PolythError(error.status, error.code, `${error.message}. Check \`polyth log ${sessionId.slice(0, 8)}\`${key ? "; retrying with the same --idempotency-key is safe" : ""}.`);
    }
    ctx.o.err(style.yellow(ctx.o.color, "Delivery is not confirmed yet; the server is reconciling it. Following the session…"));
    result = { unconfirmed: true };
  }
  if (!bool(args, "wait")) {
    if (ctx.o.json) ctx.o.data({ sessionId, ...result });
    else ctx.o.err(`${style.green(ctx.o.color, "✓")} sent to ${sessionId.slice(0, 8)}${result.queued ? " (queued)" : ""}`);
    return 0;
  }
  const { outcome, text: reply } = await awaitTurn(ctx, client, sessionId, before, {
    render: !ctx.o.json, timeoutSec: seconds(args, "timeout", 0), reasoning: bool(args, "reasoning"),
  });
  if (ctx.o.json) ctx.o.data({ sessionId, reason: outcome.reason, ...(outcome.error ? { error: outcome.error } : {}), text: reply });
  return outcome.reason === "completed" ? 0 : outcome.reason === "aborted" ? 8 : 1;
}

export const newSession: Command = {
  name: "new",
  aliases: ["run"],
  summary: "Create a session and send it a prompt",
  usage: "polyth new [-p PROJECT] [-t TITLE] [-m provider/model] [--harness ID] [--wait] [PROMPT | -]",
  details: [
    "The prompt comes from the arguments, or from standard input when piped / given as -.",
    "With --wait the reply streams to the terminal and the exit status reflects the turn",
    "(0 completed, 1 failed, 8 stopped). With --json only the final result is printed:",
    "  polyth new -p api --wait --json \"summarize open TODOs\" | jq -r .text",
  ].join("\n"),
  flags: [
    { name: "project", short: "p", value: true, description: "Project id, name or path" },
    { name: "title", short: "t", value: true, description: "Session title (default: from the prompt)" },
    { name: "harness", value: true, description: "Harness id (claude, codex, opencode…); default: project setting" },
    { name: "agent", value: true, description: "Agent name" },
    ...sendFlags,
  ],
  async run(ctx, args) {
    const client = ctx.client();
    const project = await resolveProject(client, str(args, "project"));
    const prompt = await textArg(args.positionals);
    const title = str(args, "title") ?? (prompt ? truncate(oneLine(prompt), 60) : "CLI session");
    const harness = str(args, "harness");
    const model = modelRef(str(args, "model"));
    const created = await client.post<{ id: string }>("/api/sessions", {
      projectId: project.id,
      title,
      ...(harness ? { harness: { mode: "pinned", harnessId: harness } } : {}),
      ...(model ? { model } : {}),
      ...(str(args, "agent") ? { agent: str(args, "agent") } : {}),
    });
    if (!ctx.o.json) ctx.o.err(`${style.green(ctx.o.color, "✓")} session ${style.bold(ctx.o.color, created.id)} in ${project.name}`);
    if (!prompt) {
      if (ctx.o.json) ctx.o.data(created);
      else ctx.o.out(created.id);
      return 0;
    }
    return sendAndMaybeWait(ctx, client, created.id, prompt, args, undefined);
  },
};

export const send: Command = {
  name: "send",
  summary: "Send a message to a session (queue, steer or interrupt while it works)",
  usage: "polyth send SESSION [--queue | --steer | --interrupt] [--wait] [TEXT | -]",
  flags: [
    { name: "queue", description: "Run after the current turn" },
    { name: "steer", description: "Add guidance to the running turn" },
    { name: "interrupt", description: "Stop the current turn and send this instead" },
    ...sendFlags,
  ],
  async run(ctx, args) {
    const client = ctx.client();
    const [first, ...rest] = args.positionals;
    const id = await resolveSessionId(client, first);
    const text = await textArg(rest);
    if (!text.trim()) throw new UsageError("nothing to send");
    const delivery = bool(args, "interrupt") ? "interrupt" : bool(args, "steer") ? "steer" : bool(args, "queue") ? "queue" : undefined;
    return sendAndMaybeWait(ctx, client, id, text, args, delivery);
  },
};

const lifecycle = (name: string, summary: string, path: string, done: string): Command => ({
  name,
  summary,
  usage: `polyth ${name} SESSION`,
  async run(ctx, args) {
    const client = ctx.client();
    const id = await resolveSessionId(client, args.positionals[0]);
    await client.post(`/api/sessions/${enc(id)}/${path}`, path === "abort" ? { source: "cli" } : {});
    if (ctx.o.json) ctx.o.data({ ok: true, sessionId: id });
    else ctx.o.err(`${style.green(ctx.o.color, "✓")} ${done} ${id.slice(0, 8)}`);
  },
});

export const stop = { ...lifecycle("stop", "Stop the running turn", "abort", "stopped"), aliases: ["cancel", "abort"] };
export const archive = lifecycle("archive", "Archive a session", "archive", "archived");
export const restore = lifecycle("restore", "Restore an archived session", "restore", "restored");

export const fork: Command = {
  name: "fork",
  summary: "Fork a session (optionally at an event sequence)",
  usage: "polyth fork SESSION [--at SEQ]",
  flags: [{ name: "at", value: true, description: "Event sequence to fork at" }],
  async run(ctx, args) {
    const client = ctx.client();
    const id = await resolveSessionId(client, args.positionals[0]);
    const at = str(args, "at");
    const result = await client.post<{ id?: string; sessionId?: string }>(`/api/sessions/${enc(id)}/fork`, at ? { atSeq: int(args, "at", 0, 1) } : {});
    const forked = result.id ?? result.sessionId;
    if (ctx.o.json) ctx.o.data(result);
    else ctx.o.out(forked ?? JSON.stringify(result));
  },
};

export const remove: Command = {
  name: "rm",
  aliases: ["delete"],
  summary: "Permanently delete a session",
  usage: "polyth rm SESSION --yes",
  flags: [{ name: "yes", short: "y", description: "Confirm permanent deletion" }],
  async run(ctx, args) {
    const client = ctx.client();
    const id = await resolveSessionId(client, args.positionals[0]);
    if (!bool(args, "yes")) throw new UsageError(`this permanently deletes ${id}; repeat with --yes (or use \`polyth archive\`)`);
    await client.request("DELETE", `/api/sessions/${enc(id)}`);
    ctx.o.err(`${style.green(ctx.o.color, "✓")} deleted ${id.slice(0, 8)}`);
  },
};

export const queue: Command = {
  name: "queue",
  summary: "Show or edit a session's queued messages",
  usage: "polyth queue SESSION [ls]\n       polyth queue SESSION rm ITEM\n       polyth queue SESSION edit ITEM TEXT",
  async run(ctx, args) {
    const client = ctx.client();
    const [sessionArg, action = "ls", item, ...text] = args.positionals;
    const id = await resolveSessionId(client, sessionArg);
    const base = `/api/sessions/${enc(id)}/queue`;
    if (action === "ls") {
      const items = await client.get<Array<{ id: string; text: string; delivery?: string; createdAt?: number }>>(base);
      if (ctx.o.json) { ctx.o.data(items); return; }
      if (!items.length) { ctx.o.err("Queue is empty."); return; }
      table(ctx.o, ["ITEM", "QUEUED", "TEXT"], items.map((q) => [style.dim(ctx.o.color, q.id.slice(0, 8)), ago(q.createdAt), oneLine(q.text)]));
      return;
    }
    if (!item) throw new UsageError("which queued item? (see `polyth queue SESSION`)");
    const items = await client.get<Array<{ id: string }>>(base);
    const match = items.filter((q) => q.id.startsWith(item));
    if (match.length !== 1) throw new UsageError(match.length ? "ambiguous item id" : "no such queued item");
    const itemId = match[0]!.id;
    if (action === "rm") await client.request("DELETE", `${base}/${enc(itemId)}`);
    else if (action === "edit") await client.request("PATCH", `${base}/${enc(itemId)}`, { body: { text: text.join(" ") } });
    else throw new UsageError(`unknown action "${action}"`);
    ctx.o.err(`${style.green(ctx.o.color, "✓")} ${action === "rm" ? "removed" : "updated"}`);
  },
};

export const wait: Command = {
  name: "wait",
  summary: "Block until a session is idle or needs you (for scripts)",
  usage: "polyth wait SESSION [--until idle|request|any] [--timeout 10m]",
  details: "Exit status: 0 condition met, 7 timeout. With --json prints the session summary.",
  flags: [
    { name: "until", value: true, description: "idle (default), request (a permission/question is open), any (either)" },
    { name: "timeout", value: true, description: "Give up after this long (default: no limit)" },
  ],
  async run(ctx, args) {
    const client = ctx.client();
    const id = await resolveSessionId(client, args.positionals[0]);
    const until = str(args, "until") ?? "idle";
    if (!["idle", "request", "any"].includes(until)) throw new UsageError("--until must be idle, request or any");
    const timeoutSec = seconds(args, "timeout", 0);
    const met = (s: SessionSummary) => {
      const pending = (s.attention?.permissions ?? 0) + (s.attention?.questions ?? 0) > 0;
      const idle = !ACTIVE.has(s.status);
      return until === "idle" ? idle : until === "request" ? pending : idle || pending;
    };
    const controller = new AbortController();
    const timer = timeoutSec ? setTimeout(() => controller.abort(), timeoutSec * 1000) : undefined;
    process.once("SIGINT", () => controller.abort());
    try {
      let current = await session(client, id);
      if (met(current)) { if (ctx.o.json) ctx.o.data(current); return 0; }
      const start = await highWater(client, id);
      for await (const event of followSession(client, id, start, controller.signal)) {
        if (!/^(turn\/stopped|permission\/requested|question\/asked|session\/archived|turn\/started)$/.test(event.type)) continue;
        current = await session(client, id);
        if (met(current)) { if (ctx.o.json) ctx.o.data(current); return 0; }
      }
      ctx.o.err(`timed out waiting for ${id.slice(0, 8)}`);
      return 7;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};
