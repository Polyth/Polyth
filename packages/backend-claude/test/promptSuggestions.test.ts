import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HarnessContext, RuntimeEvent } from "@polyth/contracts";
import type { HarnessNativePluginManager } from "@polyth/contracts/capability-installations";
import type { createProcessAuthority } from "@polyth/harness-runtime";
import { claudeSkillLaunchOptions, createClaudeRuntime, type ClaudeLaunchPreferences } from "../src/index.ts";
import { createClaudePreferences } from "../src/preferences.ts";

const context = { spaceId: "s", projectId: "p", cwd: "/tmp", sessionId: "canonical" };
const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

async function openRuntime(preferences?: ClaudeLaunchPreferences) {
    let input!: AsyncIterator<any>;
    let push: (message: any) => void = () => {};
    let closed = false;
    let options: Record<string, unknown> = {};
    const receipts: Record<string, string> = {};
    const sdk = {
        query(args: any) {
            options = args.options;
            input = args.prompt[Symbol.asyncIterator]();
            const pending: any[] = [];
            let wake: (() => void) | undefined;
            push = (message) => { pending.push(message); wake?.(); };
            return {
                async *[Symbol.asyncIterator]() {
                    while (!closed) {
                        if (!pending.length) await new Promise<void>((resolve) => { wake = resolve; });
                        while (pending.length) yield pending.shift();
                    }
                },
                initializationResult: async () => ({}),
                supportedModels: async () => [],
                getContextUsage: async () => ({ totalTokens: 1, maxTokens: 10 }),
                interrupt: async () => {},
                close() { closed = true; wake?.(); },
            } as any;
        },
        getSessionInfo: async () => undefined as any,
    };
    const authority = {
        authorityId: "owned",
        generation: 1,
        receipts,
        releasedAuthorities: [],
        spawn() { throw new Error("SDK fake does not spawn"); },
        receipt: async (operationId: string, id: string) => { receipts[operationId] = id; },
        close: async () => { closed = true; },
    } as Awaited<ReturnType<typeof createProcessAuthority>>;
    const runtime = await createClaudeRuntime(context, sdk, authority, preferences ? { launchPreferences: async () => preferences } : {});
    const events: RuntimeEvent[] = [];
    runtime.onEvent((_sid, event) => events.push(event));
    await runtime.createSessionOperation!({ projectId: "p", sessionId: "canonical", title: "x", cwd: "/tmp" }, "create");
    return { runtime, events, push: (message: any) => push(message), input: () => input, options: () => options };
}

test("Claude asks for prompt suggestions and forwards the post-turn suggestion as a presentation hint", async () => {
    const f = await openRuntime();
    try {
        assert.equal(f.options().promptSuggestions, true, "suggestions are on by default");
        assert.deepEqual(f.options().skills, [], "no native skill is inherited by default");
        const admission = f.runtime.startTurnOperation!({ sessionId: "canonical", text: "hi" }, "turn-1");
        await f.input().next();
        f.push({ type: "system", subtype: "status", status: "requesting", uuid: "status" });
        assert.equal((await admission).kind, "confirmed");
        f.push({ type: "result", uuid: "result-1", is_error: false, subtype: "success" });
        // The SDK delivers the suggestion after `result`, outside any turn.
        f.push({ type: "prompt_suggestion", uuid: "s-1", session_id: "native", suggestion: "  Now add tests for it  " });
        f.push({ type: "prompt_suggestion", uuid: "s-2", session_id: "native", suggestion: "   " });
        await flush();
        const stop = f.events.findIndex((event) => event.type === "turn/stopped");
        const suggestions = f.events.filter((event) => event.type === "runtime/prompt-suggestion");
        assert.deepEqual(suggestions, [{ type: "runtime/prompt-suggestion", suggestion: "Now add tests for it" }], "blank suggestions are dropped");
        assert.ok(f.events.indexOf(suggestions[0]!) > stop, "the hint follows the closed turn");
    } finally {
        await f.runtime.dispose();
    }
});

test("Claude launch honours the Space's suggestion and inherited-skill preferences", async () => {
    const f = await openRuntime({ promptSuggestions: false, inheritSkills: true, mutedSkills: ["pdf", "tools:lint"] });
    try {
        assert.equal(f.options().promptSuggestions, false);
        assert.equal(f.options().skills, "all");
        assert.deepEqual(f.options().settings, { skillOverrides: { pdf: "off", "tools:lint": "off" } });
    } finally {
        await f.runtime.dispose();
    }
});

test("skill launch options keep Polyth's own skills on even when the same name is muted", () => {
    assert.deepEqual(claudeSkillLaunchOptions({ inheritSkills: false, mutedSkills: ["x"] }, ["polyth-a"]), { skills: ["polyth-a"] });
    assert.deepEqual(claudeSkillLaunchOptions({ inheritSkills: true, mutedSkills: ["polyth-a"] }, ["polyth-a"]), { skills: "all" });
});

test("Claude native skill discovery lists project, user and enabled plugin skills under the Space policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "polyth-claude-skills-"));
    try {
        const config = join(root, "config");
        const project = join(root, "project");
        const writeSkill = async (dir: string, name: string, description: string) => {
            await mkdir(join(dir, name), { recursive: true });
            await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: "${description}"\n---\nBody\n`);
        };
        await writeSkill(join(config, "skills"), "pdf", "Read PDFs");
        await writeSkill(join(project, ".claude", "skills"), "deploy", "Ship it");
        const plugins: HarnessNativePluginManager = {
            support: () => ({ actions: [], installScopes: [], installHint: "", applies: "next-session", marketplaces: false }),
            list: async () => ({
                harnessId: "claude",
                support: { actions: [], installScopes: [], installHint: "", applies: "next-session", marketplaces: false },
                checkedAt: 1,
                plugins: [
                    { harnessId: "claude", id: "tools@m", name: "tools", source: { kind: "marketplace" }, scope: "user", enabled: true, evidence: { stage: "discovered", source: "t" }, components: [{ kind: "skill", count: 1, names: ["lint"], effect: "hidden-by-polyth" }] },
                    { harnessId: "claude", id: "off@m", name: "off", source: { kind: "marketplace" }, scope: "user", enabled: false, evidence: { stage: "discovered", source: "t" }, components: [{ kind: "skill", count: 1, names: ["nope"], effect: "hidden-by-polyth" }] },
                ],
            }),
        };
        const prefs = createClaudePreferences({ harnessId: "claude", configDir: () => config, plugins, files: { dir: () => join(root, "space") } });
        const ctx = { spaceId: "s", projectId: "p", cwd: project, space: { spaceId: "s", deployment: "local-trusted" } } as unknown as HarnessContext;

        const initial = await prefs.skills.list(ctx);
        assert.equal(initial.supported, true);
        assert.equal(initial.inherit, false);
        assert.deepEqual(initial.skills.map((skill) => [skill.name, skill.source, skill.enabled]), [
            ["deploy", "project", false], ["pdf", "user", false], ["tools:lint", "plugin", false],
        ]);
        assert.equal(initial.skills.find((skill) => skill.name === "pdf")?.description, "Read PDFs");

        await prefs.skills.update(ctx, { inherit: true });
        const muted = await prefs.skills.update(ctx, { skill: { name: "pdf", enabled: false } });
        assert.deepEqual(muted.skills.map((skill) => [skill.name, skill.enabled]), [["deploy", true], ["pdf", false], ["tools:lint", true]]);
        assert.deepEqual(await prefs.launch(ctx), { promptSuggestions: true, inheritSkills: true, mutedSkills: ["pdf"] });

        await prefs.applyControl(ctx, "prompt-suggestions", false);
        assert.equal((await prefs.launch(ctx)).promptSuggestions, false);
        assert.deepEqual((await prefs.controls(ctx)).map((control) => [control.id, control.value]), [["prompt-suggestions", false]]);
        await assert.rejects(prefs.applyControl(ctx, "prompt-suggestions", "yes"), /on or off/);

        const shared = { ...ctx, space: { spaceId: "s", deployment: "self-hosted-shared" } } as unknown as HarnessContext;
        const refused = await prefs.skills.list(shared);
        assert.equal(refused.supported, false);
        assert.deepEqual(refused.skills, [], "a shared server never lists the host's skills");
        assert.equal((await prefs.launch(shared)).inheritSkills, false, "a stored opt-in never leaks into a shared Space");
        await assert.rejects(prefs.skills.update(shared, { inherit: true }), /local, single-user/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
