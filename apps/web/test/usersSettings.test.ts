import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { en } from "../src/i18n/locales/en.ts";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("Users is a first-class visible Settings page", async () => {
  const settings = await source("../src/components/SettingsView.tsx");
  assert.match(settings, /import UsersPage from "\.\/settings\/UsersPage\.tsx"/);
  assert.match(settings, /id: "users",[\s\S]*?label: tr\("settingsview\.users"\)[\s\S]*?render: \(target\) => <UsersPage \{\.\.\.\(target \? \{ settingsTarget: target \} : \{\}\)\} \/>/);
  const usersEntry = settings.match(/\{ id: "users"[^\n]+/s)?.[0] ?? "";
  assert.doesNotMatch(usersEntry, /nav:\s*false/);
});

test("Users page lists accounts and drills into one management view", async () => {
  const users = await source("../src/components/settings/UsersPage.tsx");
  assert.match(users, />\{tr\("settings\.users\.addUser"\)\}</);
  assert.match(users, /title=\{tr\("settings\.users\.addUser"\)\}/);
  assert.match(users, /tr\("settings\.users\.createUser"\)/);
  assert.match(users, /tr\("settings\.users\.searchUsers"\)/);
  assert.match(users, /aria-label=\{tr\("settings\.users\.manageUser", \{ name \}\)\}/);
  assert.equal(en["settings.users.addUser"], "Add user");
  assert.equal(en["settings.users.createUser"], "Create user");
  assert.equal(en["settings.users.searchUsers"], "Search users");
  assert.equal(en["settings.users.manageUser"], "Manage {name}");
  assert.match(users, /<UserDetail/);
  // The owner's password is asked only when the server wants it, inside a prompt.
  assert.doesNotMatch(users, /Confirm with your password/);
  assert.match(users, /useOwnerReauth/);
});

test("the management view covers access, projects, assistants, daily limits and protection", async () => {
  const detail = await source("../src/components/settings/UserDetail.tsx");
  const titles = {
    profile: "Profile",
    projects: "Projects",
    assistants: "Assistants",
    dailyLimits: "Daily limits",
    protectedMode: "Protected mode",
    password: "Password",
    disableAccount: "Disable account",
  } as const;
  for (const [key, title] of Object.entries(titles)) {
    assert.match(detail, new RegExp(`title=\\{tr\\("settings\\.users\\.${key}"\\)\\}`), title);
    assert.equal(en[`settings.users.${key}` as keyof typeof en], title);
  }
  assert.match(detail, /label=\{tr\("settings\.users\.canSignIn"\)\}/);
  assert.match(detail, /\["all", tr\("settings\.users\.allProjects"\)\], \["selected", tr\("settings\.users\.onlySelected"\)\]/);
  assert.match(detail, /\["all", tr\("settings\.users\.allAssistants"\)\], \["selected", tr\("settings\.users\.onlySelected"\)\]/);
  assert.equal(en["settings.users.canSignIn"], "Can sign in");
  assert.equal(en["settings.users.allProjects"], "All projects");
  assert.equal(en["settings.users.allAssistants"], "All assistants");
  assert.equal(en["settings.users.onlySelected"], "Only selected");
  assert.match(detail, /setAccountLimits\(/);
  assert.match(detail, /setAccountGuardrails\(/);
  // The owner grants assistant management per account; never in Protected mode.
  assert.match(detail, /label=\{tr\("settings\.users\.canManageAssistants"\)\}/);
  assert.equal(en["settings.users.canManageAssistants"], "Can manage assistants");
  assert.match(detail, /setAccountPermissions\(/);
  assert.match(detail, /disabled=\{busy \|\| isDisabled \|\| !!guardDto\?\.guardrails\}/);
  // Own private harness accounts are a separate grant, implied by managing,
  // and the hint says they are separated by policy, not by the OS.
  assert.match(detail, /label=\{tr\("settings\.users\.canAddOwnHarness"\)\}/);
  assert.equal(en["settings.users.canAddOwnHarness"], "Can add own harness accounts");
  assert.match(detail, /changePermission\("harnesses\.personal"/);
  assert.match(detail, /tr\("settings\.users\.canAddOwnHarnessHint"\)/);
  assert.match(en["settings.users.canAddOwnHarnessHint"], /every agent runs as the same system user/);
  assert.match(detail, /disabled=\{busy \|\| isDisabled \|\| !!guardDto\?\.guardrails \|\| canManageHarnesses\}/);
  assert.match(detail, /resetAccountPassword\(/);
  assert.match(detail, /<SaveBar/);
});

test("Users page has a hairline list and a phone layout", async () => {
  const styles = await source("../src/styles.css");
  assert.match(styles, /\.users-page-filter\s*\{/);
  assert.match(styles, /\.users-self-card\s*\{/);
  assert.match(styles, /\.users-list > li \+ li\s*\{[^}]*border-top/s);
  assert.match(styles, /\.user-row\s*\{[^}]*min-height:\s*max\(56px, var\(--hit-min\)\)/s);
  assert.match(styles, /\.user-detail-savebar\s*\{[^}]*position:\s*sticky/s);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*?\.user-detail-inline\s*\{[^}]*width:\s*100%/s);
});

test("the Access page is gone and its settings live in Users and Polyth Link", async () => {
  const settings = await source("../src/components/SettingsView.tsx");
  assert.doesNotMatch(settings, /AccessPage|id: "access"/);
  const header = await source("../src/components/Header.tsx");
  assert.doesNotMatch(header, /openSettingsPage\("access"\)/);
  assert.match(header, /openSettingsPage\("users", \{ itemId: OWN_ACCOUNT_TARGET \}\)/);
  const server = await source("../../../packages/server/src/packages.ts");
  assert.doesNotMatch(server, /id: "access"/);

  // Edit own user: the account card opens AccountDetail, deep links land there.
  const users = await source("../src/components/settings/UsersPage.tsx");
  assert.match(users, /aria-label=\{tr\("header\.yourAccount"\)\}/);
  assert.equal(en["header.yourAccount"], "Your account");
  assert.match(users, /<AccountDetail/);
  assert.match(users, /settingsTarget\?\.itemId === OWN_ACCOUNT_TARGET/);
  assert.match(users, /<SignInProviders withReauth=\{withReauth\} \/>/);
  const own = await source("../src/components/settings/AccountDetail.tsx");
  const ownTitles = {
    "settings.users.profile": "Profile",
    "settings.users.signIn": "Sign-in",
    "settings.account.devicesTitle": "Where you're signed in",
    "settings.accesspage.signOut": "Sign out",
  } as const;
  for (const [key, title] of Object.entries(ownTitles)) {
    assert.match(own, new RegExp(`title=\\{tr\\("${key.replace(/\./g, "\\.")}"\\)\\}`), title);
    assert.equal(en[key as keyof typeof en], title);
  }
  assert.match(own, /changeAccountPassword\(/);
  assert.match(own, /registerPasskey\(/);
  assert.match(own, /removePasskey\(/);
  assert.match(own, /\/api\/auth\/logout-all/);
  assert.match(own, /<LinkedSignIns \/>/);
  const identity = await source("../src/components/settings/ExternalIdentitySettings.tsx");
  assert.match(identity, /"\/\?settings=users\/account"/);

  // The server facts moved to Polyth Link's host card.
  const link = await source("../../../packages/tunnel/widgets/LinkPage.tsx");
  assert.match(link, /className="pkg-tunnel-hero"/);
  assert.match(link, /\/api\/auth\/status/);
});
