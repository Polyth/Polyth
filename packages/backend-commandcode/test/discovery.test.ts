import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandCodeModelList } from "../src/discovery.ts";

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
