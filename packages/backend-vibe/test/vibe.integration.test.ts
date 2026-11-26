// End-to-end against a real Mistral Vibe `vibe-acp` and a local fake of an
// OpenAI-compatible chat-completions endpoint: no model is called and nothing
// is paid for. Opt in with POLYTH_TEST_VIBE_BIN=/path/to/vibe-acp (a
// `uv tool install mistral-vibe`); without it the suite is skipped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_TURN_CONTENT_EVENT_TYPES, type AgentRuntime, type HarnessContext, type RuntimeEvent } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createAcpProvider, invalidateAcpDiscovery } from "@polyth/backend-acp";
import { createVibeProfile } from "../src/serverEntry.ts";

const vibe = process.env.POLYTH_TEST_VIBE_BIN?.trim();
const skip = vibe ? false : "set POLYTH_TEST_VIBE_BIN to a Mistral Vibe vibe-acp executable";

type Message = { role: string; content?: unknown; tool_calls?: unknown[] };
type Body = { model?: string; reasoning_effort?: string; tools?: Array<{ function?: { name?: string } }>; messages?: Message[] };
const requests: Body[] = [];
/** Requests without tools: Vibe's own title request. */
let titleRequests = 0;

const textOf = (content: unknown): string => typeof content === "string" ? content
    : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join(" ") : "";

/** Every response reports the same counters, so a turn's share is exact. */
const USAGE = { prompt_tokens: 1200, completion_tokens: 7, total_tokens: 1207, prompt_tokens_details: { cached_tokens: 100 } };

function fakeChatCompletions() {
    let n = 0;
    return (req: IncomingMessage, res: ServerResponse) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            if (!req.url?.endsWith("/chat/completions")) { res.writeHead(404).end("{}"); return; }
            const body = JSON.parse(raw) as Body;
            const id = ++n;
            const messages = body.messages ?? [];
            // Vibe's title request carries no tools; it is not a turn's request.
            const titleRequest = !body.tools?.length;
            if (titleRequest) titleRequests++;
            else requests.push(body);
            const promptIndex = messages.map((message) => message.role === "user" && /SCENARIO:/.test(textOf(message.content))).lastIndexOf(true);
            const scenario = /SCENARIO:(\w+)/.exec(textOf(messages[promptIndex]?.content))?.[1] ?? "text";
            const results = messages.slice(promptIndex + 1).filter((message) => message.role === "tool").length;
            const base = { id: `c${id}`, object: "chat.completion.chunk", created: 1, model: body.model };
            const stream = (deltas: Array<Record<string, unknown>>, finish: string) => {
                res.writeHead(200, { "content-type": "text/event-stream" });
                for (const delta of deltas) res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: USAGE })}\n\n`);
                res.end("data: [DONE]\n\n");
            };
            const call = (name: string, args: unknown) => stream([{ role: "assistant", tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }], "tool_calls");
            if (titleRequest) { stream([{ role: "assistant", content: "A title" }], "stop"); return; }
            if (scenario === "unauthorized") {
                res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Unauthorized", type: "invalid_request_error", code: "401" } }));
                return;
            }
            if (scenario === "todo" && results === 0) {
                call("todo", { action: "write", todos: [{ id: "a", content: "Inspect", status: "completed" }, { id: "b", content: "Report", status: "in_progress" }] });
                return;
            }
            if (scenario === "write" && results === 0) {
                call("write_file", { path: "made.txt", content: "made by vibe" });
                return;
            }
            if (scenario === "slow") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                const timer = setInterval(() => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "tick " }, finish_reason: null }] })}\n\n`), 100);
                res.on("close", () => clearInterval(timer));
                return;
            }
            stream([{ role: "assistant", content: results ? "Done." : "pong" }], "stop");
        });
    };
}

/** Vibe stores installed plugin files read-only; make them removable. */
const writable = async (dir: string): Promise<void> => {
    await chmod(dir, 0o700).catch(() => {});
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await writable(path);
        else await chmod(path, 0o600).catch(() => {});
    }
};

const until = async (predicate: () => boolean, label: string, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
};

test("Mistral Vibe over ACP: catalog, turns, usage, todos, permissions, failures, resume and import", { skip, timeout: 300_000 }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "polyth-vibe-")));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const server = createServer(fakeChatCompletions());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const saved = { ...process.env };
    delete process.env.MISTRAL_API_KEY;
    Object.assign(process.env, {
        POLYTH_VIBE_BIN: vibe,
        VIBE_HOME: join(root, "home"),
        FAKE_KEY: "fake-integration-key",
        VIBE_PROVIDERS: JSON.stringify([{ name: "fake", api_base: `http://127.0.0.1:${port}/v1`, api_key_env_var: "FAKE_KEY" }]),
        VIBE_MODELS: JSON.stringify([
            { name: "fake-model", provider: "fake", alias: "fake" },
            { name: "fake-model-2", provider: "fake", alias: "fake-2" },
        ]),
        VIBE_ACTIVE_MODEL: "fake",
        VIBE_ENABLE_TELEMETRY: "false",
    });
    const host = { spaceStorage: () => ({ path: (relative: string) => join(root, "storage", relative) }) } as unknown as ServerPackageHost;
    const context: HarnessContext = { spaceId: "s", projectId: "p", cwd: workspace, space: { spaceId: "s", userId: "u" } as HarnessContext["space"] };
    const runtimes: AgentRuntime[] = [];
    try {
        invalidateAcpDiscovery();
        const provider = createAcpProvider(host, createVibeProfile());
        assert.equal(provider.staticFeatures?.usage, true);
        const probe = await provider.probe(context);
        assert.equal(probe.installed, true, probe.message);
        assert.match(probe.version ?? "", /^\d+\.\d+\.\d+/);

        const discovered = await provider.discover!(context);
        assert.equal(discovered.state, "ready", discovered.message);
        const models = discovered.state === "ready" ? discovered.catalog?.models ?? [] : [];
        assert.ok(models.some((model) => model.modelID === "fake") && models.some((model) => model.modelID === "fake-2"), JSON.stringify(models));

        const sessionContext = { ...context, sessionId: "canonical" };
        const runtime = await provider.createRuntime(sessionContext);
        runtimes.push(runtime);
        const events: RuntimeEvent[] = [];
        runtime.onEvent((_sid, event) => events.push(event));
        const created = await runtime.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: workspace }, "create");
        assert.equal(created.kind, "confirmed");
        const backendSessionId = created.kind === "confirmed" ? created.value.backendSessionId : "";
        const turn = async (id: string, text: string, model?: { providerID: string; modelID: string; variant?: string }) => {
            const outcome = await runtime.startTurnOperation!({ sessionId: "canonical", text, ...(model ? { model } : {}) }, id);
            assert.equal(outcome.kind, "confirmed", JSON.stringify(outcome));
            await until(() => events.some((event) => event.type === "turn/stopped" && event.turnId === id), `turn ${id}`);
            return events.splice(0);
        };

        // 1. A todo call becomes a task snapshot; the turn's two requests are
        //    reported once, as the turn's own share of the session totals.
        const first = await turn("t1", "SCENARIO:todo plan it");
        const types = first.map((event) => event.type);
        // Occupancy, commands and Vibe's provisional title (the prompt's first
        // line) are not turn content and may precede admission.
        const content = new Set<string>([...RUNTIME_TURN_CONTENT_EVENT_TYPES, "turn/started"]);
        assert.equal(types.includes("session/title-generated"), false, types.join());
        assert.equal(types.filter((type) => content.has(type))[0], "turn/started", types.join());
        assert.equal(types.at(-1), "turn/stopped");
        const snapshot = first.findLast((event) => event.type === "task/snapshot") as Extract<RuntimeEvent, { type: "task/snapshot" }>;
        assert.deepEqual(snapshot?.items.map((item) => [item.text, item.status]), [["Inspect", "done"], ["Report", "active"]]);
        const usage = first.filter((event) => event.type === "usage/recorded") as Array<Extract<RuntimeEvent, { type: "usage/recorded" }>>;
        assert.deepEqual(usage.map((event) => [event.model, event.tokens, event.turnId, event.quality, event.aggregate]), [
            [{ providerID: "vibe", modelID: "fake" }, { input: 2200, output: 14, cacheRead: 200 }, "t1", "exact", true],
        ]);
        assert.ok(first.some((event) => event.type === "context/updated"));
        assert.ok(first.some((event) => event.type === "assistant/message" && event.text === "Done."));
        const tools = requests.at(-1)?.tools?.map((tool) => tool.function?.name ?? "") ?? [];
        assert.ok(tools.includes("bash") && tools.includes("todo") && tools.includes("run_typescript"), tools.join());
        for (const name of ["cron", "create_goal", "update_goal", "get_goal", "wait"]) {
            assert.equal(tools.includes(name), false, `native ${name} must be disabled`);
        }

        // 2. A model and thinking-level choice reaches the provider request.
        const second = await turn("t2", "SCENARIO:text hello", { providerID: "vibe", modelID: "fake-2", variant: "high" });
        assert.equal(requests.at(-1)?.model, "fake-model-2");
        assert.ok(second.some((event) => event.type === "assistant/message" && event.text === "pong"));
        assert.deepEqual((second.filter((event) => event.type === "usage/recorded") as Array<Extract<RuntimeEvent, { type: "usage/recorded" }>>).map((event) => [event.model.modelID, event.tokens]), [["fake-2", { input: 1100, output: 7, cacheRead: 100 }]]);

        // 3. A file write asks Polyth (Vibe runs in its `ask` policy).
        const writing = runtime.startTurnOperation!({ sessionId: "canonical", text: "SCENARIO:write" }, "t3");
        assert.equal((await writing).kind, "confirmed");
        await until(() => events.some((event) => event.type === "permission/requested"), "permission request");
        const asked = events.find((event) => event.type === "permission/requested") as Extract<RuntimeEvent, { type: "permission/requested" }>;
        assert.equal(asked.permission, "edit");
        await runtime.replyPermission("canonical", asked.requestId, "once");
        await until(() => events.some((event) => event.type === "turn/stopped" && event.turnId === "t3"), "turn t3");
        assert.equal(readFileSync(join(workspace, "made.txt"), "utf8"), "made by vibe");
        events.splice(0);

        // 4. Cancellation ends the turn as aborted.
        const slow = runtime.startTurnOperation!({ sessionId: "canonical", text: "SCENARIO:slow" }, "t4");
        assert.equal((await slow).kind, "confirmed");
        await runtime.abortOperation!("canonical", "cancel-t4");
        await until(() => events.some((event) => event.type === "turn/stopped" && event.turnId === "t4"), "turn t4");
        const aborted = events.find((event) => event.type === "turn/stopped") as { reason: string };
        assert.equal(aborted.reason, "aborted", JSON.stringify(aborted));
        events.splice(0);

        // 5. A refused key closes the turn as a classified sign-in failure.
        const refused = await runtime.startTurnOperation!({ sessionId: "canonical", text: "SCENARIO:unauthorized" }, "t5");
        if (refused.kind === "confirmed") {
            await until(() => events.some((event) => event.type === "turn/stopped" && event.turnId === "t5"), "turn t5");
            const stopped = events.findLast((event) => event.type === "turn/stopped") as Extract<RuntimeEvent, { type: "turn/stopped" }>;
            assert.equal(stopped.reason, "error");
            assert.equal(stopped.code, "auth-expired");
            assert.match(stopped.error ?? "", /API key/);
        } else {
            assert.deepEqual([refused.kind, refused.kind === "rejected" ? refused.code : undefined], ["rejected", "auth"], JSON.stringify(refused));
        }
        events.splice(0);
        await runtime.dispose();

        // 6. A fresh process loads the native session; old usage is not repeated.
        const resumed = await provider.createRuntime(sessionContext);
        runtimes.push(resumed);
        const later: RuntimeEvent[] = [];
        resumed.onEvent((_sid, event) => later.push(event));
        assert.equal(await resumed.ensureSession!({ projectId: "p", sessionId: "canonical", title: "x", cwd: workspace, backendSessionId }), backendSessionId);
        const again = await resumed.startTurnOperation!({ sessionId: "canonical", text: "SCENARIO:text again" }, "t6");
        assert.equal(again.kind, "confirmed", JSON.stringify(again));
        await until(() => later.some((event) => event.type === "turn/stopped"), "turn t6");
        const resumedUsage = later.filter((event) => event.type === "usage/recorded") as Array<Extract<RuntimeEvent, { type: "usage/recorded" }>>;
        assert.deepEqual(resumedUsage.map((event) => event.tokens), [{ input: 1100, output: 7, cacheRead: 100 }]);
        assert.ok(requests.at(-1)?.messages?.some((message) => message.role === "user" && textOf(message.content).includes("SCENARIO:todo")), "resumed history reaches the model");

        // 7. The native transcript is offered for Snapshot import. Vibe lets
        //    one process hold a session, so a live runtime blocks the read.
        await assert.rejects(async () => { for await (const _record of provider.source!.read(context, backendSessionId)) { /* drain */ } }, /open in another Mistral Vibe process/);
        await resumed.dispose();
        const listed = await provider.source!.list(context);
        assert.ok(listed.some((session) => session.ref === backendSessionId), JSON.stringify(listed));
        const dialogue: string[] = [];
        for await (const record of provider.source!.read(context, backendSessionId)) dialogue.push(`${record.role}:${record.text}`);
        assert.ok(dialogue.includes("user:SCENARIO:todo plan it") && dialogue.includes("assistant:Done."), dialogue.join("\n"));
        assert.ok(existsSync(join(root, "home", "logs", "session", "unified", backendSessionId, "meta.json")));
        // Polyth names the chat: Vibe makes no title request of its own and
        // its provisional title (the raw prompt) is never published.
        assert.equal(titleRequests, 0);
        assert.equal(provider.staticFeatures?.title, "unsupported");
    } finally {
        for (const runtime of runtimes) await runtime.dispose().catch(() => {});
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
        await writable(root);
        await rm(root, { recursive: true, force: true });
    }
});
