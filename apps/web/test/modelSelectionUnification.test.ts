// One model picker everywhere: every single-model selection surface renders the
// composer's `@polyth/models/model-picker` primitive. Only that package owns the
// catalog UI, and the primitive itself already adapts between phone and desktop
// (anchored Quiet Glass popover); consumers must not fork it or bind a native
// <select> / settings-only list to model descriptors.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

// The host surfaces that choose catalog models. Removable packages assert the
// same contract in their own tests.
const MODEL_SELECTION_SURFACES = [
  "../../../apps/web/src/components/Composer.tsx",
  "../../../apps/web/src/components/Timeline.tsx",
  "../../../apps/web/src/components/settings/SessionsPage.tsx",
  "../../../apps/web/src/components/settings/pages.tsx",
  "../../../packages/judgment/widgets/JudgmentSettings.tsx",
  "../../../packages/opencode/widgets/index.tsx",
  "../../../packages/git/widgets/CommitMessageSettings.tsx",
  "../../../packages/files/widgets/FilesSettings.tsx",
  "../../../apps/web/src/components/settings/UserDetail.tsx",
] as const;

// Sets of models: the shared picker's multi-select mode, not a menu/chip fork.
const MULTI_MODEL_SURFACES = [
  "../../../apps/web/src/components/settings/UserDetail.tsx",
] as const;

test("every model selection surface renders the shared model picker", async () => {
  for (const path of MODEL_SELECTION_SURFACES) {
    const source = await read(path);
    assert.ok(
      source.includes('from "@polyth/models/model-picker"'),
      `${path} must import the canonical picker from its declared workspace export`,
    );
    assert.match(source, /<ModelPicker\b/, `${path} must render <ModelPicker>`);
    assert.doesNotMatch(
      source,
      /packages\/models\/widgets\/ModelPicker\.tsx/,
      `${path} must not deep-import the picker implementation`,
    );
  }
});

test("no feature surface binds a native select to model descriptors", async () => {
  const source = await read("../../../packages/opencode/widgets/index.tsx");
  assert.doesNotMatch(source, /<select\b/, "model selection must use ModelPicker, not a native <select>");
  assert.doesNotMatch(source, /<option\b/, "model selection must use ModelPicker, not native <option>s");
});

test("model sets use the shared picker's multi-select mode", async () => {
  for (const path of MULTI_MODEL_SURFACES) {
    const source = await read(path);
    assert.match(source, /<ModelPicker\b[\s\S]*?\bselection=\{[\s\S]*?\bonToggle=\{/, `${path} must pick its set through ModelPicker`);
  }
});

test("no surface asks for model ids as free text or a generic select", async () => {
  const files = await read("../../../packages/files/widgets/FilesSettings.tsx");
  assert.doesNotMatch(files, /modelOverride: e\.target\.value/, "the inline-AI override is picked, not typed");
  const user = await read("../../../apps/web/src/components/settings/UserDetail.tsx");
  assert.doesNotMatch(user, /JSON\.parse\(value\) as HarnessModelRef/, "allowed models are not a generic Select");
});

test("the sessions settings page renders the composer model picker with harness tabs", async () => {
  const source = await read("../../../apps/web/src/components/settings/SessionsPage.tsx");
  assert.ok(
    source.includes('from "@polyth/models/runtime-catalog"'),
    "SessionsPage.tsx must read the composer's runtime catalog",
  );
  assert.match(
    source,
    /slot="modelPicker.header"/,
    "the picker must mount the shared harness-tabs header seam",
  );
  assert.match(
    source,
    /otherHarnesses=\{/,
    "the picker must offer cross-harness search like the composer",
  );
});
