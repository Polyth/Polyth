// P2-W2 chat presentation fixture: isolated, synthetic, disposable.
// Seeds every chat surface the wave redesigned so presentation QA never needs
// a live model: finished + still-streaming thinking, 20+ mixed tool rows with
// failed/cancelled/huge-output states, MCP calls, a task list with a failed
// item, a markdown/KaTeX/Mermaid/table showcase with attachments, pending
// permission approvals, and a stream-capable session whose fake backend emits
// reasoning + tool + text SSE (msgActionsFakeBackend.mjs, turnBehavior "work").
// Existing fixture paths are wiped only when they carry the sentinel.
//
// Usage: node apps/web/test/wave2ChatFixtureSetup.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

export const FIXTURE_ROOT = "/tmp/polyth-w2-fixture-7d20";
export const FIXTURE_DATA = "/tmp/polyth-w2-data-7d20";
export const FIXTURE_HOME = "/tmp/polyth-w2-home-7d20";
export const FIXTURE_BIN = "/tmp/polyth-w2-bin-7d20";
export const OC_SEED = join(FIXTURE_DATA, "oc-seed.json");
export const OC_STATE = join(FIXTURE_DATA, "oc-state.json");
export const PROJECT_ID = "w2-project";

export const SESSIONS = {
  thinking: "w2-thinking",
  thinkingLive: "w2-thinking-live",
  tools: "w2-tools",
  markdown: "w2-markdown",
  permission: "w2-permission",
  questions: "w2-questions",
  stream: "w2-stream",
};

const SENTINEL = ".ux-fixture-sentinel";

const resetDir = (path) => {
  if (existsSync(path)) {
    if (!existsSync(join(path, SENTINEL))) {
      throw new Error(`refusing to wipe non-fixture path: ${path}`);
    }
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(path, SENTINEL), "P2-W2 chat fixture 7d20\n");
};

const LONG_REASONING = [
  "Synthetic reasoning stream for the disclosure QA.",
  "",
  "First I check the reducer contract: reasoning chunks accumulate on one part and the wall-clock bounds come from the first and last chunk.",
  "",
  "## Weighing the options",
  "",
  "- keep milestones: loses the actual thought process",
  "- render raw text: needs a height cap and secondary styling",
  "",
  "The capped scroll well wins because long reasoning must never dominate the final answer.",
  "",
  "```ts",
  "const span = endedAt - startedAt; // powers the collapsed label",
  "```",
  "",
  ...Array.from({ length: 24 }, (_, i) =>
    `Extended synthetic consideration ${i + 1}: the expanded body has to stay readable, scroll internally, and remain visually quieter than the answer below it.`),
  "",
  "Concluding: ship the disclosure with the duration label.",
].join("\n");

const MARKDOWN_SHOWCASE = [
  "Full markdown surface check:",
  "",
  "| Surface | State | Notes |",
  "| --- | --- | --- |",
  "| Tables | pass | intrinsic width, wrapped cells |",
  "| Code | pass | internal horizontal scroll only |",
  "| Math | pass | KaTeX block + inline |",
  "",
  "Inline math $e^{i\\pi} + 1 = 0$ and a display block:",
  "",
  "$$",
  "\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}",
  "$$",
  "",
  "```mermaid",
  "flowchart LR",
  "  U[User intent] --> T[Thinking]",
  "  T --> X[Tool execution]",
  "  X --> P{Approval?}",
  "  P -- allow --> R[Result]",
  "  P -- deny --> T",
  "```",
  "",
  "```ts",
  "export const wide = (a: number, b: number, c: number, d: number, e: number): number => a + b + c + d + e; // deliberately-long-single-line-to-force-internal-horizontal-scrolling-in-the-code-surface",
  "```",
  "",
  `A long unbroken URL wraps without page overflow: https://example.invalid/w2/${"segment/".repeat(14)}${"x".repeat(120)}`,
].join("\n");

export async function buildWave2ChatFixture() {
  for (const p of [FIXTURE_ROOT, FIXTURE_DATA, FIXTURE_HOME, FIXTURE_BIN]) resetDir(p);

  // --- synthetic project repository ------------------------------------------
  writeFileSync(join(FIXTURE_ROOT, "README.md"), "# P2-W2 synthetic chat fixture\n\nDisposable repository for chat presentation QA.\n");
  mkdirSync(join(FIXTURE_ROOT, "docs"), { recursive: true });
  writeFileSync(join(FIXTURE_ROOT, "docs/notes.md"), "Synthetic attachment target.\n");
  const git = (...args) => execFileSync("git", ["-C", FIXTURE_ROOT, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "W2 Chat Fixture Bot");
  git("config", "user.email", "w2-fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-m", "chore: seed synthetic w2 chat fixture");

  // --- fake backend binary on PATH -------------------------------------------
  const fake = join(here, "msgActionsFakeBackend.mjs");
  const wrapper = join(FIXTURE_BIN, "opencode");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(wrapper, 0o755);

  writeFileSync(OC_SEED, JSON.stringify({
    sessions: [
      {
        id: "oc_w2_work",
        title: "W2 streaming work session",
        turnBehavior: "work",
        messages: [
          { id: "w2_u0", role: "user", text: "Warm-up prompt before streaming QA." },
          { id: "w2_a0", role: "assistant", text: "Settled synthetic answer before any live stream." },
        ],
      },
    ],
  }, null, 2));

  // --- isolated Polyth data ----------------------------------------------------
  writeFileSync(join(FIXTURE_DATA, "projects.json"), JSON.stringify([{
    id: PROJECT_ID,
    path: FIXTURE_ROOT,
    name: "W2 Chat Fixture",
    createdAt: Date.now(),
  }], null, 2));

  const { createStore } = await import(join(REPO_ROOT, "packages/session/src/index.ts"));
  const store = createStore(join(FIXTURE_DATA, "sessions.db"));
  const now = Date.now();

  const projection = (id, title, status, extra = {}) => ({
    id, projectId: PROJECT_ID, title, status,
    createdAt: now - 7_200_000, updatedAt: now, ...extra,
  });
  const MODEL = { providerID: "synthetic", modelID: "fable-mini" };

  // ---- w2-thinking: finished long reasoning with a duration -------------------
  {
    const id = SESSIONS.thinking;
    await store.append(id, "session/created", { title: "Thinking showcase" }, { ignorable: true });
    await store.append(id, "user/message", { text: "Redesign the thinking disclosure; show your reasoning." });
    await store.append(id, "turn/started", { turnId: `${id}-t1`, model: MODEL, agent: "build" }, { ignorable: true });
    // Chunked reasoning: the 2s-per-seq rewrite below turns 10 chunks into an
    // ~18s span, so the collapsed label reads "Thinking · 18s".
    const pieces = 10;
    const step = Math.ceil(LONG_REASONING.length / pieces);
    for (let i = 0; i < pieces; i++) {
      await store.append(id, "assistant/reasoning-chunk", { partId: `${id}-p1`, text: LONG_REASONING.slice(i * step, (i + 1) * step) });
    }
    await store.append(id, "assistant/message", {
      partId: `${id}-p1`,
      text: "Shipped the redesigned disclosure: collapsed it is one quiet line with a duration; expanded it renders the real reasoning as secondary markdown in a capped scroll well.",
      reasoning: LONG_REASONING,
      tokens: { input: 900, output: 220 },
      cost: 0.03,
    });
    await store.append(id, "turn/stopped", { turnId: `${id}-t1`, reason: "completed" }, { ignorable: true });
    await store.upsertProjection(projection(id, "Thinking showcase", "idle"));
  }

  // ---- w2-thinking-live: reasoning mid-stream (active turn, no finalize) ------
  {
    const id = SESSIONS.thinkingLive;
    await store.append(id, "session/created", { title: "Thinking (live)" }, { ignorable: true });
    await store.append(id, "user/message", { text: "Hold an active thinking state for streaming QA." });
    await store.append(id, "turn/started", { turnId: `${id}-t1`, model: MODEL, agent: "build" }, { ignorable: true });
    await store.append(id, "assistant/reasoning-chunk", { partId: `${id}-p1`, text: "Reading the current disclosure implementation.\n\n" });
    await store.append(id, "assistant/reasoning-chunk", { partId: `${id}-p1`, text: "The collapsed summary should preview the newest thought while streaming." });
    await store.upsertProjection(projection(id, "Thinking (live)", "working"));
  }

  // ---- w2-tools: 20+ tools, failure, cancellation, huge output, MCP, tasks ----
  {
    const id = SESSIONS.tools;
    let c = 0;
    const call = async (tool, input, result) => {
      c += 1;
      const callId = `${id}-c${c}`;
      await store.append(id, "tool/call", { callId, tool, input });
      if (result?.error !== undefined) {
        await store.append(id, "tool/error", { callId, tool, error: result.error });
      } else if (result !== null) {
        await store.append(id, "tool/result", { callId, tool, output: result?.output ?? "", ...(result?.title ? { title: result.title } : {}), ...(result?.metadata ? { metadata: result.metadata } : {}) });
      }
      return callId;
    };
    await store.append(id, "session/created", { title: "Tool marathon" }, { ignorable: true });
    await store.append(id, "user/message", { text: "Audit the chat surfaces, run the build, and fix what breaks." });
    await store.append(id, "turn/started", { turnId: `${id}-t1`, model: MODEL, agent: "build" }, { ignorable: true });
    await store.append(id, "task/snapshot", {
      listId: "todo", revision: 1, items: [
        { id: "t1", text: "Inspect chat components", status: "active" },
        { id: "t2", text: "Run the production build", status: "pending" },
        { id: "t3", text: "Fix the failing surface", status: "pending" },
        { id: "t4", text: "Verify huge-output handling", status: "pending" },
        { id: "t5", text: "Check MCP integrations", status: "pending" },
        { id: "t6", text: "Validate legacy import shim", status: "pending" },
        { id: "t7", text: "Final responsive QA", status: "pending" },
      ],
    }, { ignorable: true });
    // Inspection group: reads + searches (collapsible work group material).
    for (const f of ["apps/web/src/components/Timeline.tsx", "apps/web/src/components/ExecutionRow.tsx", "apps/web/src/execution.ts", "apps/web/src/reduce.ts", "apps/web/src/utils.ts", "apps/web/src/styles.css"]) {
      await call("read", { filePath: f }, { output: `// synthetic contents of ${f}\nexport {};` });
    }
    await call("grep", { pattern: "reasoning" }, { output: "apps/web/src/reduce.ts:412:reasoning\napps/web/src/utils.ts:88:reasoning\napps/web/src/components/Timeline.tsx:98:reasoning" });
    await call("glob", { pattern: "**/*.test.ts" }, { output: "apps/web/test/smoke.test.ts\napps/web/test/markdown.test.ts" });
    await call("list", { path: "apps/web/src" }, { output: "components/\nexecution.ts\nreduce.ts" });
    await store.append(id, "task/snapshot", {
      listId: "todo", revision: 2, items: [
        { id: "t1", text: "Inspect chat components", status: "done" },
        { id: "t2", text: "Run the production build", status: "active" },
        { id: "t3", text: "Fix the failing surface", status: "pending" },
        { id: "t4", text: "Verify huge-output handling", status: "pending" },
        { id: "t5", text: "Check MCP integrations", status: "pending" },
        { id: "t6", text: "Validate legacy import shim", status: "pending" },
        { id: "t7", text: "Final responsive QA", status: "pending" },
      ],
    }, { ignorable: true });
    // Failed build, a fix, then a green re-run.
    await call("bash", { command: "npm run build", description: "Build the web bundle" }, {
      error: "Command failed with exit code 1\napps/web/src/components/Broken.tsx:12:5 - error TS2304: Cannot find name 'unfinishedSymbol'.\n    12     unfinishedSymbol();\n           ~~~~~~~~~~~~~~~~",
    });
    await call("edit", { filePath: "apps/web/src/components/Broken.tsx", oldString: "unfinishedSymbol();", newString: "finishedSymbol();" }, { output: "ok", metadata: { diff: "--- a\n+++ b\n@@ -12,1 +12,1 @@\n-    unfinishedSymbol();\n+    finishedSymbol();" } });
    await call("bash", { command: "npm run build", description: "Rebuild after the fix" }, { output: "esbuild: 436 files written\nDone in 640ms" });
    // Cancelled long test run (derived cancelled state).
    await call("bash", { command: "npm test -- --watch", description: "Watch mode test run" }, { error: "Cancelled by user before completion" });
    // Huge output: ~200KB synthetic log.
    await call("bash", { command: "npm test 2>&1 | tee /tmp/full.log", description: "Full test suite" }, {
      output: Array.from({ length: 2400 }, (_, i) => `[${String(i).padStart(5, "0")}] synthetic assertion pass: chat surface invariant ${i % 37} holds under load`).join("\n"),
    });
    await store.append(id, "task/snapshot", {
      listId: "todo", revision: 3, items: [
        { id: "t1", text: "Inspect chat components", status: "done" },
        { id: "t2", text: "Run the production build", status: "done" },
        { id: "t3", text: "Fix the failing surface", status: "done" },
        { id: "t4", text: "Verify huge-output handling", status: "active" },
        { id: "t5", text: "Check MCP integrations", status: "pending" },
        { id: "t6", text: "Validate legacy import shim", status: "failed" },
        { id: "t7", text: "Final responsive QA", status: "pending" },
      ],
    }, { ignorable: true });
    // MCP calls: friendly label + technical id in details.
    await call("mcp__github__get_pull_request", { description: "Read pull request #2693", owner: "synthetic", repo: "polyth" }, {
      output: JSON.stringify({ title: "Synthetic PR", state: "open", additions: 120, deletions: 34, html_url: "https://github.example.invalid/synthetic/polyth/pull/2693" }),
    });
    await call("mcp__github__search_code", { q: "reasoningTail repo:synthetic/polyth" }, { output: JSON.stringify({ total_count: 3, items: [{ path: "apps/web/src/execution.ts" }] }) });
    await call("mcp__posthog__run_query", { description: "Query weekly active sessions" }, { output: JSON.stringify({ rows: [[1834]], columns: ["was"] }) });
    // Fetch + subagent + a couple of edits and a still-running tail.
    await call("webfetch", { url: "https://docs.example.invalid/agent-chat-guidelines", format: "markdown" }, { output: "# Synthetic guidelines\n\nCalm, quiet, progressive disclosure." });
    await call("task", { description: "Audit mobile chat geometry", subagent_type: "general", prompt: "Check 320-390px widths" }, { output: "Audit complete: no horizontal overflow found." });
    await call("edit", { filePath: "apps/web/src/styles.css", oldString: ".old-rule { }", newString: ".new-rule { color: var(--text); }" }, { output: "ok" });
    await call("write", { filePath: "docs/qa-notes.md", content: "synthetic\nnotes\n" }, { output: "ok" });
    await call("read", { filePath: "docs/qa-notes.md" }, { output: "synthetic\nnotes" });
    await call("bash", { command: "npx tsc --noEmit", description: "Typecheck" }, { output: "" });
    // One still-running row at the tail (active turn).
    await call("bash", { command: "node scripts/final-qa.mjs --responsive", description: "Final responsive QA" }, null);
    await store.append(id, "assistant/message", {
      partId: `${id}-p1`,
      text: "Build fixed and re-verified; the huge log stays behind a bounded preview. Final responsive QA is still running.",
      tokens: { input: 4200, output: 300 },
      cost: 0.11,
    });
    await store.upsertProjection(projection(id, "Tool marathon", "working"));
  }

  // ---- w2-markdown: markdown/KaTeX/Mermaid/table showcase + attachments -------
  {
    const id = SESSIONS.markdown;
    await store.append(id, "session/created", { title: "Markdown showcase" }, { ignorable: true });
    await store.append(id, "user/message", {
      text: "Render the full markdown surface — tables, math, Mermaid, wide code — and keep my attachments visible.",
      attachments: [
        { id: "att-1", name: "notes.md", mime: "text/markdown", size: 34, kind: "file", path: "docs/notes.md" },
        { id: "att-2", name: "PR #42", mime: "text/uri-list", size: 0, kind: "url", url: "https://github.example.invalid/synthetic/polyth/pull/42" },
      ],
    });
    await store.append(id, "turn/started", { turnId: `${id}-t1`, model: MODEL, agent: "build" }, { ignorable: true });
    await store.append(id, "assistant/message", { partId: `${id}-p1`, text: MARKDOWN_SHOWCASE, tokens: { input: 300, output: 500 }, cost: 0.02 });
    await store.append(id, "usage/recorded", { model: MODEL, tokens: { input: 300, output: 500 }, cost: 0.02 }, { ignorable: true });
    await store.append(id, "turn/stopped", { turnId: `${id}-t1`, reason: "completed" }, { ignorable: true });
    await store.upsertProjection(projection(id, "Markdown showcase", "idle"));
  }

  // ---- w2-permission: pending approvals (preview + patterns-only) --------------
  {
    const id = SESSIONS.permission;
    await store.append(id, "session/created", { title: "Approvals pending" }, { ignorable: true });
    await store.append(id, "user/message", { text: "Clean the build artifacts and fetch the deploy manifest." });
    await store.append(id, "turn/started", { turnId: `${id}-t1`, model: MODEL, agent: "build" }, { ignorable: true });
    await store.append(id, "assistant/message", { partId: `${id}-p0`, text: "I need two approvals before continuing." });
    await store.append(id, "permission/requested", {
      requestId: `${id}-perm-1`,
      permission: "bash",
      tool: "Shell",
      patterns: ["rm -rf apps/web/dist"],
      preview: { title: "Delete build artifacts", lines: ["rm -rf apps/web/dist", "cwd: /workspace"], risk: "medium" },
      allowedScopes: ["once", "session", "project"],
    });
    await store.append(id, "permission/requested", {
      requestId: `${id}-perm-2`,
      permission: "webfetch",
      patterns: ["https://deploy.example.invalid/manifest.json"],
      allowedScopes: ["once", "session"],
    });
    await store.upsertProjection(projection(id, "Approvals pending", "waiting"));
  }

  // ---- w2-questions: pending multi-step agent question ------------------------
  {
    const id = SESSIONS.questions;
    await store.append(id, "session/created", { title: "Agent questions" }, { ignorable: true });
    await store.append(id, "user/message", { text: "Confirm the release strategy before implementation." });
    await store.append(id, "turn/started", { turnId: `${id}-t1`, model: MODEL, agent: "build" }, { ignorable: true });
    await store.append(id, "assistant/message", { partId: `${id}-p0`, text: "I need a few product choices before I continue." });
    await store.append(id, "question/asked", {
      requestId: `${id}-request`,
      questions: [
        {
          id: "release",
          title: "Release channel",
          prompt: "Which audience should receive this build first?",
          options: [
            { value: "internal", label: "Internal team", description: "Fastest feedback with no customer exposure." },
            { value: "beta", label: "Beta customers", description: "Broader validation behind an opt-in flag." },
            { value: "all", label: "All customers", description: "Publish directly to the stable channel." },
          ],
          allowOther: true,
        },
        {
          id: "checks",
          title: "Required checks",
          prompt: "Which validation gates must pass?",
          type: "multi",
          options: ["Build", "Unit tests", "Browser QA", "Accessibility review"],
        },
        {
          id: "notes",
          title: "Release notes",
          prompt: "Add any constraints the implementation should preserve.",
          required: false,
        },
      ],
    });
    await store.upsertProjection(projection(id, "Agent questions", "waiting"));
  }

  // ---- w2-stream: live streaming against the fake backend ---------------------
  {
    const id = SESSIONS.stream;
    await store.append(id, "session/created", { title: "W2 streaming work session" }, { ignorable: true });
    await store.append(id, "user/message", { text: "Warm-up prompt before streaming QA." });
    await store.append(id, "turn/started", { turnId: `${id}-t1` }, { ignorable: true });
    await store.append(id, "assistant/message", { partId: `${id}-p1`, text: "Settled synthetic answer before any live stream." });
    await store.append(id, "turn/stopped", { turnId: `${id}-t1`, reason: "completed" }, { ignorable: true });
    await store.upsertProjection(projection(id, "W2 streaming work session", "idle", { backendSessionId: "oc_w2_work" }));
  }

  await store.close();

  // Deterministic 2s-per-seq event times, base two hours ago.
  const db = new DatabaseSync(join(FIXTURE_DATA, "sessions.db"));
  db.prepare("UPDATE events SET time = ? + seq * 2000").run(now - 7_200_000);
  db.close();

  return {};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await buildWave2ChatFixture();
  console.log("P2-W2 chat fixture ready.");
  console.log(`# project: ${PROJECT_ID}  data: ${FIXTURE_DATA}  home: ${FIXTURE_HOME}  bin: ${FIXTURE_BIN}`);
}
