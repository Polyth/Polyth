import { spawn } from "node:child_process";
import { bool, int, list, str, UsageError } from "../args.ts";
import { openRequests, resolveProject, resolveSessionId, summaries, tail } from "../api.ts";
import type { Command } from "../context.ts";
import { sessionFeed, type FeedEvent, type FeedEventType } from "../follow.ts";
import { oneLine, style, table, truncate } from "../output.ts";

const FEED_TYPES: readonly FeedEventType[] = [
  "session.created", "session.updated", "turn.started", "turn.finished", "request.pending", "session.archived",
];

function feedTypes(raw: string[]): Set<FeedEventType> {
  const types = new Set<FeedEventType>();
  for (const value of raw) {
    if (!(FEED_TYPES as readonly string[]).includes(value)) throw new UsageError(`unknown event type "${value}"; use ${FEED_TYPES.join(", ")}`);
    types.add(value as FeedEventType);
  }
  return types;
}

export const events: Command = {
  name: "events",
  summary: "Stream session state changes as JSON lines (for scripts)",
  usage: "polyth events [-p PROJECT | --all] [--type turn.finished,request.pending] [--since CURSOR]",
  details: [
    `Event types: ${FEED_TYPES.join(", ")}.`,
    "Each line is one JSON object with type, sessionId, projectId, title, status and a",
    "cursor; pass the last cursor to --since to resume after a restart. Without",
    "--since, only changes from now on are reported. Runs until interrupted.",
    "",
    "  polyth events --type turn.finished | while read -r e; do",
    "    notify-send \"$(jq -r .title <<<\"$e\") finished\"",
    "  done",
  ].join("\n"),
  flags: [
    { name: "project", short: "p", value: true },
    { name: "all", short: "a", description: "Every project in the Space" },
    { name: "type", short: "t", value: true, multiple: true, description: "Only these event types (comma-separated)" },
    { name: "since", value: true, description: "Resume after this cursor (milliseconds timestamp)" },
  ],
  async run(ctx, args) {
    const client = ctx.client();
    const project = bool(args, "all") ? undefined : await resolveProject(client, str(args, "project")).catch((e) => {
      if (str(args, "project")) throw e;
      return undefined;
    });
    const types = feedTypes(list(args, "type"));
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    const since = str(args, "since") !== undefined ? int(args, "since", 0) : undefined;
    if (process.stderr.isTTY) ctx.o.err(style.dim(ctx.o.color, `Watching ${project ? project.name : "all projects"}… (Ctrl+C to stop)`));
    for await (const event of sessionFeed(client, { ...(project ? { projectId: project.id } : {}), ...(since !== undefined ? { since } : {}), signal: controller.signal })) {
      if (types.size && !types.has(event.type)) continue;
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
    return 0;
  },
};

export const on: Command = {
  name: "on",
  summary: "Run a command whenever an event happens",
  usage: "polyth on EVENT[,EVENT] [-p PROJECT | --all] [--once] -- COMMAND [ARGS…]",
  details: [
    `EVENT is one of ${FEED_TYPES.join(", ")}.`,
    "The command gets the event as JSON on stdin and in the environment:",
    "POLYTH_EVENT, POLYTH_SESSION_ID, POLYTH_PROJECT_ID, POLYTH_SESSION_TITLE, POLYTH_SESSION_STATUS.",
    "Handlers run one at a time, in order. A failing handler is reported and the",
    "watch continues.",
    "",
    "  polyth on turn.finished -p api -- ./scripts/on-finished.sh",
    "  polyth on request.pending --all -- notify-send 'Polyth needs you'",
  ].join("\n"),
  flags: [
    { name: "project", short: "p", value: true },
    { name: "all", short: "a" },
    { name: "once", description: "Exit after the first handled event (exit status of the handler)" },
  ],
  async run(ctx, args) {
    const [which] = args.positionals;
    if (!which || !args.rest.length) throw new UsageError("usage: polyth on EVENT -- COMMAND [ARGS…]");
    const types = feedTypes(which.split(",").map((t) => t.trim()).filter(Boolean));
    const client = ctx.client();
    const project = bool(args, "all") ? undefined : await resolveProject(client, str(args, "project")).catch((e) => {
      if (str(args, "project")) throw e;
      return undefined;
    });
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    const [command, ...commandArgs] = args.rest as [string, ...string[]];
    ctx.o.err(style.dim(ctx.o.color, `On ${[...types].join(", ")} in ${project ? project.name : "all projects"} → ${args.rest.join(" ")}`));
    const run = (event: FeedEvent) => new Promise<number>((resolve) => {
      const child = spawn(command, commandArgs, {
        stdio: ["pipe", "inherit", "inherit"],
        env: {
          ...process.env,
          POLYTH_EVENT: event.type,
          POLYTH_SESSION_ID: event.sessionId,
          POLYTH_PROJECT_ID: event.projectId,
          POLYTH_SESSION_TITLE: event.title ?? "",
          POLYTH_SESSION_STATUS: event.status,
        },
      });
      child.on("error", (error) => { ctx.o.err(style.red(ctx.o.color, `handler failed to start: ${error.message}`)); resolve(127); });
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
      child.stdin.on("error", () => {});
      child.stdin.end(`${JSON.stringify(event)}\n`);
    });
    for await (const event of sessionFeed(client, { ...(project ? { projectId: project.id } : {}), signal: controller.signal })) {
      if (!types.has(event.type)) continue;
      const code = await run(event);
      if (code !== 0) ctx.o.err(style.yellow(ctx.o.color, `handler exited ${code} for ${event.type} ${event.sessionId.slice(0, 8)}`));
      if (bool(args, "once")) return code;
    }
    return 0;
  },
};

export const requests: Command = {
  name: "requests",
  aliases: ["req"],
  summary: "List open permission requests and questions; answer or reject questions",
  usage: [
    "polyth requests [SESSION]                  # open requests (default: every session needing you)",
    "polyth requests answer SESSION REQUEST ANSWER…",
    "polyth requests reject SESSION REQUEST     # reject a question or a permission request",
    "polyth requests approve SESSION REQUEST    # only in the owner-enabled no-token CLI mode",
  ].join("\n       "),
  flags: [{ name: "always", description: "With approve: remember for this session" }],
  async run(ctx, args) {
    const client = ctx.client();
    const [action, ...rest] = args.positionals;
    const enc = encodeURIComponent;
    if (action === "answer" || action === "reject" || action === "approve") {
      const [sessionArg, requestId, ...answer] = rest;
      if (!sessionArg || !requestId) throw new UsageError(`polyth requests ${action} SESSION REQUEST`);
      if (action === "approve" && !(await ctx.whoami()).trustedCli) {
        throw new UsageError("approving agent actions is a person's decision in the Polyth UI (polyth open). The owner can allow it from the CLI by enabling the no-token CLI mode.");
      }
      const id = await resolveSessionId(client, sessionArg);
      const open = openRequests(await tail(client, id, 1000)).find((r) => r.requestId === requestId || r.requestId.startsWith(requestId));
      if (!open) throw new UsageError(`no open request "${requestId}" in ${id.slice(0, 8)}`);
      if (action === "approve") {
        if (open.kind !== "permission") throw new UsageError("approve applies to permission requests; answer questions with `answer`");
        await client.post(`/api/sessions/${enc(id)}/permission/${enc(open.requestId)}`,
          bool(args, "always") ? { reply: "always", scope: "session" } : { reply: "once" });
      } else if (action === "reject") {
        if (open.kind === "permission") await client.post(`/api/sessions/${enc(id)}/permission/${enc(open.requestId)}`, { reply: "reject" });
        else await client.post(`/api/sessions/${enc(id)}/question/${enc(open.requestId)}/reject`, {});
      } else {
        if (open.kind !== "question") throw new UsageError("only questions take an answer; permission requests are approved or rejected");
        const text = answer.join(" ");
        if (!text) throw new UsageError("give the answer text (or one of the listed option values)");
        const chosen = open.options?.find((o) => o.value === text || o.label.toLowerCase() === text.toLowerCase());
        await client.post(`/api/sessions/${enc(id)}/question/${enc(open.requestId)}`, {
          answers: { [open.questionId ?? "q0"]: chosen ? chosen.value : text },
        });
      }
      ctx.o.err(`${style.green(ctx.o.color, "✓")} ${action === "answer" ? "answered" : action === "reject" ? "rejected" : "approved"}`);
      return 0;
    }
    const sessionsToScan = action
      ? [await resolveSessionId(client, action)]
      : (await summaries(client, { attentionOnly: true, limit: 50 })).sessions
        .filter((s) => (s.attention?.permissions ?? 0) + (s.attention?.questions ?? 0) > 0)
        .map((s) => s.id);
    const found = (await Promise.all(sessionsToScan.map(async (id) => openRequests(await tail(client, id, 1000))))).flat();
    if (ctx.o.json) { ctx.o.data(found); return 0; }
    if (!found.length) { ctx.o.err("Nothing is waiting for you."); return 0; }
    table(ctx.o, ["SESSION", "REQUEST", "KIND", "WHAT"], found.map((r) => [
      style.dim(ctx.o.color, r.sessionId.slice(0, 8)),
      truncate(r.requestId, 28),
      r.kind === "permission" ? style.yellow(ctx.o.color, "permission") : style.cyan(ctx.o.color, "question"),
      `${r.title}${r.detail ? `: ${oneLine(r.detail)}` : ""}${r.options ? ` [${r.options.map((o) => o.label).join(" | ")}]` : ""}`,
    ]));
    return 0;
  },
};
