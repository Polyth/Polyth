import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROJECT_DIRECTIONS } from "@polyth/contracts/project-composition";
import {
  nextProjectName,
  PROJECT_COLORS,
  PROJECT_ICON_STARTER_COUNT,
  projectIconStarters,
  refreshProjectIdentityDraft,
  unusedProjectColor,
} from "../src/projectIdentity.ts";

const onDisk = (value: string): boolean =>
  existsSync(fileURLToPath(new URL(`../src/assets/project-icons/${value.slice(value.lastIndexOf("/") + 1)}`, import.meta.url)));

test("every direction offers a full set of icons that ship with the app", () => {
  for (const directions of [[], ...PROJECT_DIRECTIONS.map((direction) => [direction])]) {
    const icons = projectIconStarters(directions);
    assert.equal(icons.length, PROJECT_ICON_STARTER_COUNT, String(directions));
    assert.equal(new Set(icons).size, icons.length, "no icon twice");
    for (const icon of icons) {
      assert.match(icon, /^\/assets\/project-icons\/[a-z0-9]+(?:-[a-z0-9]+)*\.svg$/, "the server accepts this path");
      assert.ok(onDisk(icon), icon);
    }
  }
});

test("each direction leads with its own icon, and several take turns", () => {
  assert.equal(projectIconStarters(["home"])[0], "/assets/project-icons/house.svg");
  assert.equal(projectIconStarters(["finance"])[0], "/assets/project-icons/piggy-bank.svg");
  const mixed = projectIconStarters(["home", "finance"]);
  assert.deepEqual(mixed.slice(0, 2), ["/assets/project-icons/house.svg", "/assets/project-icons/piggy-bank.svg"]);
  assert.equal(mixed.length, PROJECT_ICON_STARTER_COUNT);
});

test("a new project takes a colour nobody uses, and the palette is never left", () => {
  assert.equal(unusedProjectColor([]), "#3f7de8");
  assert.equal(unusedProjectColor(["#3F7DE8", undefined]), "#43b7a6", "case does not hide a used colour");
  const all = [...PROJECT_COLORS];
  assert.equal(unusedProjectColor([...all, ...all.filter((color) => color !== "#7253e8")]), "#7253e8", "then the least used");
  assert.ok((PROJECT_COLORS as readonly string[]).includes(unusedProjectColor(all)));
});

test("a default name never repeats one a project already has", () => {
  assert.equal(nextProjectName("Новий проєкт", []), "Новий проєкт");
  assert.equal(nextProjectName("Новий проєкт", ["новий проєкт "]), "Новий проєкт 2");
  assert.equal(nextProjectName("Дім", ["Дім", "Дім 2"]), "Дім 3");
});

test("refreshing the defaults keeps only what the person chose", () => {
  const defaults = { name: "Фінанси", color: "#3f7de8", icon: "/assets/project-icons/coins.svg" };
  const first = refreshProjectIdentityDraft(null, defaults);
  assert.deepEqual(first, { ...defaults, nameEdited: false, colorEdited: false, iconEdited: false });

  const later = { name: "Дім", color: "#65b955", icon: "/assets/project-icons/house.svg" };
  assert.deepEqual(refreshProjectIdentityDraft(first, later), { ...later, nameEdited: false, colorEdited: false, iconEdited: false });

  const edited = { ...first, name: "Моє", nameEdited: true };
  assert.deepEqual(refreshProjectIdentityDraft(edited, later), { ...later, name: "Моє", nameEdited: true, colorEdited: false, iconEdited: false });
});
