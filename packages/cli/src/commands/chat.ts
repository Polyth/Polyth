// Line-mode chat: the reply streams under the prompt, tools collapse to one
// line, Ctrl+C stops the running turn (twice at an idle prompt exits).
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { str } from "../args.ts";
import { highWater, modelRef, openRequests, resolveProject, resolveSessionId, session, tail } from "../api.ts";
import type { Command } from "../context.ts";
import { followSession } from "../follow.ts";
import { style } from "../output.ts";
import { createRenderer } from "../render.ts";
import { openSessionUi } from "./admin.ts";

const HELP = [
  "/stop            stop the running turn (or press Ctrl+C)",
  "/queue TEXT      run TEXT after the current turn",
  "/steer TEXT      add guidance to the running turn",
  "/model P/M       use another model from the next message",
  "/requests        show what is waiting for you",
  "/open            open this session in Polyth",
  "/id              print the session id",
  "/exit            leave (the session keeps running)",
  "End a line with \\ to continue on the next line.",
].join("\n");

export const chat: Command = {
  name: "chat",
  aliases: ["attach"],
  summary: "Chat with a session interactively (new session if none given)",
  usage: "polyth chat [SESSION] [-p PROJECT] [-m provider/model] [--reasoning]",
  flags: [
    { name: "project", short: "p", value: true },
    { name: "model", short: "m", value: true },
    { name: "title", short: "t", value: true },
    { name: "reasoning", description: "Show model reasoning" },
    { name: "history", short: "n", value: true, description: "Recent events to show when attaching (default 40)" },
  ],
  async run(ctx, args) {
    const o = ctx.o;
    if (!process.stdin.isTTY) {
      o.err("polyth chat needs an interactive terminal; use `polyth send --wait` in scripts.");
      return 2;
    }
    const client = ctx.client();
    let model = modelRef(str(args, "model"));
    let sessionId: string | undefined = args.positionals[0] ? await resolveSessionId(client, args.positionals[0]) : undefined;
    let projectName = "";
    if (!sessionId) {
      const project = await resolveProject(client, str(args, "project"));
      projectName = project.name;
    }
    const renderer = createRenderer(o, { userMessages: false, reasoning: args.flags.reasoning === true });
    const prompt = () => style.bold(o.color, style.blue(o.color, "› "));
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: prompt(), terminal: true, historySize: 200 });
    let busy = false;
    let follower: AbortController | undefined;
    let interrupts = 0;

    const startFollowing = async (id: string, from: number) => {
      follower?.abort();
      const controller = new AbortController();
      follower = controller;
      void (async () => {
        try {
          for await (const event of followSession(client, id, from, controller.signal)) {
            if (event.type === "turn/started") busy = true;
            const outcome = renderer.event(event);
            if (outcome) {
              busy = false;
              renderer.finish();
              rl.prompt();
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) o.err(style.red(o.color, `\nlost the session stream: ${(error as Error).message}`));
        }
      })();
    };

    if (sessionId) {
      const s = await session(client, sessionId);
      projectName = s.projectId;
      o.err(style.dim(o.color, `Attached to ${s.title ?? sessionId} — ${s.status}. /help for commands.`));
      const history = Number(str(args, "history") ?? 40);
      const recent = history > 0 ? await tail(client, sessionId, Math.min(history, 2000)) : [];
      const replay = createRenderer(o, { userMessages: true });
      for (const event of recent) replay.event(event);
      replay.finish();
      busy = s.status === "working" || s.status === "waiting" || s.status === "reconciling";
      await startFollowing(sessionId, recent.at(-1)?.seq ?? await highWater(client, sessionId));
    } else {
      o.err(style.dim(o.color, `New chat in ${projectName}. The session is created with your first message. /help for commands.`));
    }

    const send = async (text: string, delivery?: string) => {
      if (!sessionId) {
        const project = await resolveProject(client, str(args, "project"));
        const title = str(args, "title") ?? (text.replace(/\s+/g, " ").trim().slice(0, 60) || "CLI chat");
        const created = await client.post<{ id: string }>("/api/sessions", { projectId: project.id, title, ...(model ? { model } : {}) });
        sessionId = created.id;
        o.err(style.dim(o.color, `session ${created.id}`));
        await startFollowing(sessionId, await highWater(client, sessionId));
      }
      await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
        text, clientOperationId: randomUUID(), ...(delivery ? { delivery } : {}), ...(model ? { model } : {}),
      });
      if (!delivery || delivery === "interrupt") busy = true;
    };

    const stop = async () => {
      if (!sessionId) return;
      await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { source: "cli" }).catch((e) => o.err(style.red(o.color, (e as Error).message)));
    };

    let pending = "";
    rl.on("SIGINT", () => {
      if (busy) {
        o.err(style.yellow(o.color, "\n(stopping…)"));
        void stop();
        return;
      }
      if (pending) { pending = ""; o.out(); rl.prompt(); return; }
      interrupts += 1;
      if (interrupts >= 2) rl.close();
      else { o.err(style.dim(o.color, "\n(Ctrl+C again or /exit to leave)")); rl.prompt(); }
    });

    rl.on("line", (input) => {
      interrupts = 0;
      if (input.endsWith("\\")) { pending += `${input.slice(0, -1)}\n`; rl.setPrompt(style.dim(o.color, "… ")); rl.prompt(); return; }
      const line = (pending + input).trim();
      pending = "";
      rl.setPrompt(prompt());
      if (!line) { rl.prompt(); return; }
      void (async () => {
        try {
          if (line.startsWith("/")) {
            const [cmd = "", ...restParts] = line.slice(1).split(" ");
            const rest = restParts.join(" ").trim();
            switch (cmd) {
              case "help": case "?": o.out(HELP); break;
              case "exit": case "quit": rl.close(); return;
              case "stop": await stop(); break;
              case "queue": if (rest) await send(rest, "queue"); break;
              case "steer": if (rest) await send(rest, "steer"); break;
              case "model": model = modelRef(rest); o.err(`model → ${rest}`); break;
              case "id": o.out(sessionId ?? "(no session yet)"); break;
              case "open": if (sessionId) await openSessionUi(ctx, sessionId); break;
              case "requests": {
                if (!sessionId) break;
                const open = openRequests(await tail(client, sessionId, 1000));
                if (!open.length) o.out("Nothing is waiting for you.");
                for (const r of open) o.out(`${r.kind} ${r.requestId}: ${r.title}${r.detail ? ` — ${r.detail}` : ""}`);
                break;
              }
              default: o.err(`unknown command /${cmd} — /help`);
            }
            if (!busy) rl.prompt();
            return;
          }
          // While a turn runs a plain line is queued, like the composer;
          // /steer and /stop act on the running turn.
          const queued = busy;
          await send(line, queued ? "queue" : undefined);
          if (queued) { o.err(style.dim(o.color, "(queued — runs after the current turn)")); rl.prompt(); }
        } catch (error) {
          o.err(style.red(o.color, (error as Error).message));
          rl.prompt();
        }
      })();
    });

    rl.prompt();
    await new Promise<void>((resolve) => rl.once("close", () => resolve()));
    follower?.abort();
    renderer.finish();
    if (sessionId) o.err(style.dim(o.color, `\nsession ${sessionId}${busy ? " (still working)" : ""}`));
    return 0;
  },
};
