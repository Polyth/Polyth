import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) =>
  readFile(new URL(relative, import.meta.url), "utf8");

const AGENT_WIDGETS = [
  "AgentsPage.tsx", "AgentsHome.tsx", "AgentScreen.tsx", "AgentConversation.tsx", "AgentStart.tsx",
  "AgentEditor.tsx", "AgentNotebook.tsx", "AgentTemplates.tsx", "AgentNavSection.tsx", "AgentGlyph.tsx",
  "PageBar.tsx", "MakeAgentAction.tsx",
];

test("project picking delegates to the shared canonical project picker", async () => {
  const source = await read("../widgets/PlannerProjectPicker.tsx");
  assert.match(
    source,
    /import \{ ProjectPicker \} from "\.\.\/\.\.\/\.\.\/apps\/web\/src\/components\/ui\/index\.ts"/,
  );
  assert.match(source, /<ProjectPicker/);
  assert.doesNotMatch(source, /ResponsiveOverlay/);
});

test("the agent editor offers the composer's harness and model execution picker", async () => {
  const editor = await read("../widgets/AgentEditor.tsx");
  assert.match(editor, /import ModelPicker from "@polyth\/models\/model-picker"/);
  assert.match(editor, /slot="modelPicker\.header"/);
});

test("agent screens are inline pages: no dialogs or sheets, no autofocus", async () => {
  for (const file of AGENT_WIDGETS) {
    const source = await read(`../widgets/${file}`);
    assert.doesNotMatch(source, /<Dialog|<Sheet|ResponsiveOverlay/, `${file} opens no overlay of its own`);
    assert.doesNotMatch(source, /autoFocus/, `${file} never summons the keyboard on open`);
  }
});

test("agent styles use canonical tokens only and stay inside the package roots", async () => {
  const css = await read("../widgets/styles.css");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "no hex colours");
  assert.doesNotMatch(css, /var\(--(radius|radius-sm|radius-md|radius-lg|radius-xl|fg|danger|warning|success|info|border-subtle)\)/,
    "no deprecated aliases");
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@[^{]+\{/g, "").match(/[^{}]+(?=\{)/g) ?? [];
  for (const selector of selectors.map((value) => value.trim()).filter(Boolean)) {
    // Split the selector list on top-level commas only (`:is(a, b)` stays whole).
    for (const part of selector.split(/,(?![^(]*\))/)) {
      // .agents-page is the agents' page in place of Chat; .agent-nav the rows in the navigator;
      // .agent-chip the agent named in the header of its own session in Chat.
      assert.match(part.trim(), /^(\.agents-page|\.agent-nav|\.agent-chip|:root|from|to|\d+%)/, `"${part.trim()}" is scoped to a package root`);
    }
  }
});
