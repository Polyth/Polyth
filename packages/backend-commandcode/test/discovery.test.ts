import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COMMANDCODE_REQUIRED_FLAGS,
  commandCodeCompatibilityMessage,
  discoverCommandCodeAgents,
  inspectCommandCodeHelp,
  parseCommandCodeAgentFile,
  parseCommandCodeModelList,
} from "../src/discovery.ts";

test("Command Code model parser keeps only native ids and preserves full ids", () => {
  const models = parseCommandCodeModelList(`\nOpen Source\n  deepseek/deepseek-v4-flash\n  moonshotai/Kimi-K3\n\nOpenAI\n  gpt-5.6-sol\n  gpt-6-astra\n`);
  assert.deepEqual(models.map((model) => [model.providerID, model.modelID, model.name]), [
    ["deepseek", "deepseek/deepseek-v4-flash", "Deepseek V4 Flash"],
    ["moonshotai", "moonshotai/Kimi-K3", "Kimi K3"],
    ["command-code", "gpt-5.6-sol", "GPT 5.6 Sol"],
    ["command-code", "gpt-6-astra", "GPT 6 Astra"],
  ]);
});

test("Command Code model parser ignores headings, ANSI decoration and duplicates", () => {
  const models = parseCommandCodeModelList(`\u001b[1mOpen Source\u001b[0m\n- Qwen/Qwen3.8-Max\n- Qwen/Qwen3.8-Max\nModels available to your account\n`);
  assert.equal(models.length, 1);
  assert.equal(models[0]?.modelID, "Qwen/Qwen3.8-Max");
});

test("Command Code agent parser exposes metadata without copying the system-prompt body", () => {
  const agent = parseCommandCodeAgentFile("reviewer.md", `---\nname: code-reviewer\ndescription: "Review diffs for bugs"\nmodel: moonshotai/kimi-k3\nreasoningEffort: high\n---\nSECRET PRIVATE SYSTEM PROMPT\n`);
  assert.deepEqual(agent, {
    name: "code-reviewer",
    description: "Review diffs for bugs",
    mode: "subagent",
    model: { providerID: "moonshotai", modelID: "moonshotai/kimi-k3", variant: "high" },
  });
  assert.equal("prompt" in (agent ?? {}), false);
});

test("Command Code agent parser rejects reserved native names", () => {
  assert.equal(parseCommandCodeAgentFile("general.md", "---\nname: general\n---\ncustom override"), undefined);
  assert.equal(parseCommandCodeAgentFile("review.md", "---\nname: review\n---\ncustom override"), undefined);
});

test("Command Code agent discovery follows built-in then personal then project first-definition precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-commandcode-agents-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const personal = join(home, ".commandcode", "agents");
  const project = join(cwd, ".commandcode", "agents");
  await mkdir(personal, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(personal, "writer.md"), "---\nname: writer\ndescription: personal writer\n---\nPRIVATE PERSONAL PROMPT\n");
  await writeFile(join(project, "writer.md"), "---\nname: writer\ndescription: project writer\n---\nPRIVATE PROJECT PROMPT\n");
  await writeFile(join(project, "tester.md"), "---\nname: tester\ndescription: project tester\nmodel: claude-sonnet-5\n---\nPRIVATE TEST PROMPT\n");
  try {
    const agents = await discoverCommandCodeAgents(cwd, home);
    assert.deepEqual(agents.slice(0, 3).map((agent) => agent.name), ["general", "explore", "plan"]);
    assert.equal(agents.filter((agent) => agent.name === "writer").length, 1);
    assert.equal(agents.find((agent) => agent.name === "writer")?.description, "personal writer");
    assert.deepEqual(agents.find((agent) => agent.name === "tester")?.model, {
      providerID: "command-code",
      modelID: "claude-sonnet-5",
    });
    assert.ok(agents.every((agent) => agent.prompt === undefined));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Command Code compatibility checks the documented surfaces Polyth actually invokes", () => {
  const help = COMMANDCODE_REQUIRED_FLAGS
    .map((flag) => `  ${flag} <value>  documented option`)
    .join("\n");
  assert.deepEqual(inspectCommandCodeHelp(help), { compatible: true, missing: [] });
});

test("Command Code compatibility reports exact missing flags without semantic-version guessing", () => {
  const help = COMMANDCODE_REQUIRED_FLAGS
    .filter((flag) => flag !== "--mod" && flag !== "--tools-enable" && flag !== "--skill")
    .map((flag) => `\u001b[2m${flag}\u001b[0m`)
    .join("\n");
  const compatibility = inspectCommandCodeHelp(help);
  assert.deepEqual(compatibility, {
    compatible: false,
    missing: ["--tools-enable", "--mod", "--skill"],
  });
  assert.match(commandCodeCompatibilityMessage(compatibility), /Upgrade Command Code/);
  assert.match(commandCodeCompatibilityMessage(compatibility), /--tools-enable, --mod, --skill/);
});

test("compatibility does not confuse prefix lookalikes with required flags", () => {
  const help = COMMANDCODE_REQUIRED_FLAGS
    .map((flag) => flag === "--model" ? "--models" : flag)
    .join("\n");
  const compatibility = inspectCommandCodeHelp(help);
  assert.equal(compatibility.compatible, false);
  assert.ok(compatibility.missing.includes("--model"));
});
