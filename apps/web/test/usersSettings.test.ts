import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("Users is a first-class visible Settings page", async () => {
  const settings = await source("../src/components/SettingsView.tsx");
  assert.match(settings, /import UsersPage from "\.\/settings\/UsersPage\.tsx"/);
  assert.match(settings, /id: "users",[\s\S]*?label: tr\("settingsview\.users"\)[\s\S]*?render: \(\) => <UsersPage \/>/);
  const usersEntry = settings.match(/\{ id: "users"[^\n]+/s)?.[0] ?? "";
  assert.doesNotMatch(usersEntry, /nav:\s*false/);
});

test("Users page exposes one obvious add flow and explicit access levels", async () => {
  const users = await source("../src/components/settings/UsersPage.tsx");
  assert.match(users, />Add user</);
  assert.match(users, /title="Add user"/);
  assert.match(users, /value: "viewer"/);
  assert.match(users, /value: "member"/);
  assert.match(users, /value: "admin"/);
  assert.match(users, /value: "owner"/);
  assert.match(users, /value: "none"/);
  assert.match(users, /Create user/);
  assert.match(users, /Confirm with your password/);
  assert.match(users, /Search users/);
});

test("Users page has dedicated responsive card layout", async () => {
  const styles = await source("../src/styles.css");
  assert.match(styles, /\.users-page-toolbar\s*\{/);
  assert.match(styles, /\.user-card\s*\{[^}]*grid-template-columns:/s);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*?\.user-card\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(styles, /\.user-card-actions > \.ui-btn\s*\{[^}]*width:\s*100%/s);
});
