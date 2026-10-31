// End-to-end against a real DeepSeek Harness executable and a local fake of
// DeepSeek's Messages endpoint: no model is called and nothing is paid for.
// Opt in with POLYTH_TEST_DSH_BIN=/path/to/dsh (an `@deepseek-ai/dsh`
// install); without it the suite is skipped.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, HarnessContext, RuntimeEvent } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createAcpProvider } from "@polyth/backend-acp";
import { invalidateAcpDiscovery } from "@polyth/backend-acp";
import { createDeepSeekProfile } from "../src/serverEntry.ts";

const dsh = process.env.POLYTH_TEST_DSH_BIN?.trim();
const skip = dsh ? false : "set POLYTH_TEST_DSH_BIN to a DeepSeek Harness executable";

type Body = { model?: string; output_config?: { effort?: string }; thinking?: { type?: string }; tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: unknown }> };
const requests: Body[] = [];

const textOf = (content: unknown): string => typeof content === "string" ? content
    : Array.isArray(content) ? content.map((block) => (block as { type?: string; text?: string }).type === "text" ? (block as { text: string }).text : "").join(" ") : "";

function fakeMessages(outside: string) {
    let n = 0;
    return (req: IncomingMessage, res: ServerResponse) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            if (!req.url?.includes("/v1/messages")) { res.writeHead(404).end("{}"); return; }
            const body = JSON.parse(raw) as Body;
            requests.push(body);
            const id = ++n;
            const messages = body.messages ?? [];
            const prompt = [...messages].reverse().find((message) => message.role === "user" && /SCENARIO:/.test(textOf(message.content)));
            // After a failed turn dsh merges the next prompt into the same user
            // message, so the newest scenario is the last one in it.
            const scenario = [...textOf(prompt?.content).matchAll(/SCENARIO:(\w+)/g)].at(-1)?.[1] ?? "text";
            const results = messages.slice(messages.indexOf(prompt!)).flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => (block as { type?: string }).type === "tool_result") : []).length;
            const send = (events: Array<[string, Record<string, unknown>]>) => {
                res.writeHead(200, { "content-type": "text/event-stream" });
                for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
                res.end();
            };
            const start: [string, Record<string, unknown>] = ["message_start", { message: { id: `m${id}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 } } }];
            const text = (index: number, value: string): Array<[string, Record<string, unknown>]> => [["content_block_start", { index, content_block: { type: "text", text: "" } }], ["content_block_delta", { index, delta: { type: "text_delta", text: value } }], ["content_block_stop", { index }]];
            const tool = (index: number, name: string, input: unknown): Array<[string, Record<string, unknown>]> => [["content_block_start", { index, content_block: { type: "tool_use", id: `t${id}`, name, input: {} } }], ["content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }], ["content_block_stop", { index }]];
            const end = (reason: string, output: number): Array<[string, Record<string, unknown>]> => [["message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: output } }], ["message_stop", {}]];
            if (scenario === "unauthorized") {
                res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Authentication Fails (invalid api key)" } }));
                return;
            }
            if (scenario === "todo" && results === 0) {
                send([start, ...tool(0, "todo_write", { todos: [{ content: "Inspect", status: "completed" }, { content: "Report", status: "in_progress" }] }), ...end("tool_use", 11)]);
                return;
            }
            if (scenario === "escalate" && results < 2) {
                const input = { command: `echo outside > ${outside}`, description: "Write outside the workspace", ...(results === 1 ? { sandbox_permissions: "danger-full-access", justification: "The test writes outside the workspace." } : {}) };
                send([start, ...tool(0, "bash", input), ...end("tool_use", 13)]);
                return;
            }
            if (scenario === "slow") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", ...start[1] })}\n\n`);
                res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
                const timer = setInterval(() => res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tick " } })}\n\n`), 100);
                res.on("close", () => clearInterval(timer));
                return;
            }
            send([start, ...text(0, results ? "Done." : "pong"), ...end("end_turn", 7)]);
        });
    };
}

const until = async (predicate: () => boolean, label: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
};

test("DeepSeek Harness over ACP: catalog, turns, usage, todos, permissions, failures, resume and import", { skip, timeout: 240_000 }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "polyth-dsh-")));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace);
    const server = createServer(fakeMessages(outside));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const saved = { ...process.env };
    Object.assign(process.env, {
        POLYTH_DEEPSEEK_BIN: dsh,
        DSH_HOME: join(root, "home"),
        DEEPSEEK_API_KEY: "sk-polyth-integration-fake",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`,
        DSH_TELEMETRY_DISABLED: "1",
    });
    const host = { spaceStorage: () => ({ path: (relative: string) => join(root, "storage", relative) }) } as unknown as ServerPackageHost;
    const context: HarnessContext = { spaceId: "s", projectId: "p", cwd: workspace, space: { spaceId: "s", userId: "u" } as HarnessContext["space"] };
    const runtimes: AgentRuntime[] = [];
    try {
        invalidateAcpDiscovery();
        const provider = createAcpProvider(host, createDeepSeekProfile());
        assert.equal(provider.staticFeatures?.usage, true);
        const probe = await provider.probe(context);
        assert.equal(probe.installed, true, probe.message);
        assert.match(probe.version ?? "", /^\d+\.\d+\.\d+/);

        const discovered = await provider.discover!(context);
        assert.equal(discovered.state, "ready", discovered.message);
        const models = discovered.state === "ready" ? discovered.catalog?.models ?? [] : [];
        const pro = models.find((model) => model.modelID === "deepseek-v4-pro");
        assert.ok(models.some((model) => model.modelID === "deepseek-v4-flash"), JSON.stringify(models));
        assert.deepEqual(pro?.variants, ["off", "low", "high", "max"]);

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

        // 1. A todo tool call becomes a task snapshot, the tool keeps its name,
        //    and both responses are reported with their exact counters.
        const first = await turn("t1", "SCENARIO:todo plan it");
        const types = first.map((event) => event.type);
        // Occupancy is not turn content and may precede admission.
        assert.equal(types.filter((type) => type !== "context/updated")[0], "turn/started", types.join());
        assert.equal(types.at(-1), "turn/stopped");
        const snapshot = first.find((event) => event.type === "task/snapshot") as Extract<RuntimeEvent, { type: "task/snapshot" }>;
        assert.deepEqual(snapshot?.items.map((item) => [item.text, item.status]), [["Inspect", "done"], ["Report", "active"]]);
        assert.ok(first.some((event) => event.type === "tool/started" && event.tool === "todo_write"));
        const usage = first.filter((event) => event.type === "usage/recorded") as Array<Extract<RuntimeEvent, { type: "usage/recorded" }>>;
        assert.deepEqual(usage.map((event) => [event.model.modelID, event.tokens, event.turnId, event.quality]), [
            ["deepseek-v4-flash", { input: 1200, output: 11, cacheRead: 800, cacheWrite: 0 }, "t1", "exact"],
            ["deepseek-v4-flash", { input: 1200, output: 7, cacheRead: 800, cacheWrite: 0 }, "t1", "exact"],
        ]);
        assert.ok(types.lastIndexOf("usage/recorded") < types.indexOf("turn/stopped"));
        const occupancy = first.find((event) => event.type === "context/updated") as Extract<RuntimeEvent, { type: "context/updated" }>;
        assert.equal(occupancy?.limitTokens, 1_000_000);
        assert.ok((occupancy?.usedTokens ?? 0) > 0);
        assert.ok(first.some((event) => event.type === "assistant/message" && event.text === "Done."));
        const tools = requests.at(-1)?.tools?.map((tool) => tool.name) ?? [];
        assert.ok(tools.includes("bash") && tools.includes("todo_write"), tools.join());
        for (const name of ["subagent", "subagent_fork", "workflow", "send_message", "list_agents", "interrupt_agent"]) {
            assert.equal(tools.includes(name), false, `native ${name} must be disabled`);
        }

        // 2. Model and reasoning selection reach the provider request.
        const second = await turn("t2", "SCENARIO:text hello", { providerID: "deepseek", modelID: "deepseek-v4-pro", variant: "max" });
        assert.equal(requests.at(-1)?.model, "deepseek-v4-pro");
        assert.equal(requests.at(-1)?.output_config?.effort, "max");
        assert.ok(second.some((event) => event.type === "assistant/message" && event.text === "pong"));
        assert.deepEqual((second.filter((event) => event.type === "usage/recorded") as Array<{ model: { modelID: string } }>).map((event) => event.model.modelID), ["deepseek-v4-pro"]);

        // 3. A sandbox escalation asks Polyth, named by tool and command.
        const escalation = runtime.startTurnOperation!({ sessionId: "canonical", text: "SCENARIO:escalate" }, "t3");
        assert.equal((await escalation).kind, "confirmed");
        await until(() => events.some((event) => event.type === "permission/requested"), "permission request");
        const asked = events.find((event) => event.type === "permission/requested") as Extract<RuntimeEvent, { type: "permission/requested" }>;
        assert.equal(asked.permission, "bash");
        assert.deepEqual(asked.patterns, [`echo outside > ${outside}`]);
        await runtime.replyPermission("canonical", asked.requestId, "once");
        await until(() => events.some((event) => event.type === "turn/stopped" && event.turnId === "t3"), "turn t3");
        assert.equal(readFileSync(outside, "utf8").trim(), "outside");
        events.splice(0);

        // 4. A provider refusal closes the turn as a classified sign-in failure.
        const failed = await turn("t4", "SCENARIO:unauthorized");
        const stopped = failed.at(-1) as Extract<RuntimeEvent, { type: "turn/stopped" }>;
        assert.equal(stopped.reason, "error");
        assert.equal(stopped.code, "auth-expired");
        assert.match(stopped.error ?? "", /DeepSeek rejected the API key/);

        // 5. Cancellation ends the turn as aborted.
        const slow = runtime.startTurnOperation!({ sessionId: "canonical", text: "SCENARIO:slow" }, "t5");
        assert.equal((await slow).kind, "confirmed");
        await runtime.abortOperation!("canonical", "cancel-t5");
        await until(() => events.some((event) => event.type === "turn/stopped" && event.turnId === "t5"), "turn t5");
        const aborted = events.find((event) => event.type === "turn/stopped") as { reason: string };
        assert.equal(aborted.reason, "aborted", JSON.stringify(aborted));
        events.splice(0);
        await runtime.dispose();

        // 6. A fresh process resumes the native session; old usage is not repeated.
        const resumed = await provider.createRuntime(sessionContext);
        runtimes.push(resumed);
        const later: RuntimeEvent[] = [];
        resumed.onEvent((_sid, event) => later.push(event));
        assert.equal(await resumed.ensureSession!({ projectId: "p", sessionId: "canonical", title: "x", cwd: workspace, backendSessionId }), backendSessionId);
        const again = await resumed.startTurnOperation!({ sessionId: "canonical", text: "SCENARIO:text again" }, "t6");
        assert.equal(again.kind, "confirmed");
        await until(() => later.some((event) => event.type === "turn/stopped"), "turn t6");
        assert.equal(later.filter((event) => event.type === "usage/recorded").length, 1);
        assert.ok(textOf(requests.at(-1)?.messages?.find((message) => message.role === "user")?.content).includes("SCENARIO:todo"), "resumed history reaches the model");

        // 7. The native transcript is offered for Snapshot import.
        const listed = await provider.source!.list(context);
        assert.ok(listed.some((session) => session.ref === backendSessionId), JSON.stringify(listed));
        const dialogue: string[] = [];
        for await (const record of provider.source!.read(context, backendSessionId)) dialogue.push(`${record.role}:${record.text}`);
        assert.ok(dialogue.includes("user:SCENARIO:todo plan it") && dialogue.includes("assistant:Done."), dialogue.join("\n"));
        assert.ok(existsSync(join(root, "home", "profiles", "acp")));
    } finally {
        for (const runtime of runtimes) await runtime.dispose().catch(() => {});
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
        await rm(root, { recursive: true, force: true });
    }
});
