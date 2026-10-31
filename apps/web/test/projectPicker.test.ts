import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { projectPickerItems } from "../src/projectPicker.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("project picker items match the composer's name-over-path shape", () => {
  const items = projectPickerItems([
    { id: "alpha", name: "Alpha", path: "/work/alpha" },
    { id: "beta", name: "", path: "/work/beta" },
  ]);
  assert.deepEqual(items, [
    { id: "alpha", label: "Alpha", group: "", detail: "/work/alpha" },
    { id: "beta", label: "/work/beta", group: "", detail: "" },
  ]);
});

test("project picker items can lead with an all-projects choice", () => {
  const items = projectPickerItems(
    [{ id: "alpha", name: "Alpha", path: "/work/alpha" }],
    "All projects",
  );
  assert.deepEqual(items[0], { id: "", label: "All projects", group: "", detail: "" });
  assert.equal(items[1]?.id, "alpha");
});

test("the composer project selector and the shared ProjectPicker use one Picker", async () => {
  const contextBar = await read("../src/components/mobile/SessionContextBar.tsx");
  assert.match(contextBar, /import Picker from "\.\.\/Picker\.tsx"/);
  assert.match(contextBar, /<ProjectPicker/);

  const projectPicker = await read("../src/components/ui/ProjectPicker.tsx");
  assert.match(projectPicker, /import Picker from "\.\.\/Picker\.tsx"/);
  assert.match(projectPicker, /projectPickerItems\(/);
});

test("project choices show the project's own glyph, not a generic folder", async () => {
  const projectPicker = await read("../src/components/ui/ProjectPicker.tsx");
  assert.match(projectPicker, /<ProjectGlyph project=\{selected\} \/>/, "the chip shows the selected project's glyph");
  assert.match(projectPicker, /itemIcon=\{/, "every row leads with its project's glyph");

  const contextBar = await read("../src/components/mobile/SessionContextBar.tsx");
  assert.match(contextBar, /icon: choice\.icon/, "the composer passes project appearance through");
});

test("settings project selection delegates to the shared ProjectPicker", async () => {
  const pages = await read("../src/components/settings/pages.tsx");
  assert.match(pages, /ProjectPicker/);
  assert.match(pages, /<ProjectPicker/);
  assert.doesNotMatch(pages, /project-selector-accordion/);
});
