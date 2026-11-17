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

test("anyone renames themselves and the owner renames others, bounded like the server, and the hint says Git stays", async () => {
  const self = await source("../src/components/settings/AccountDetail.tsx");
  const other = await source("../src/components/settings/UserDetail.tsx");
  const accounts = await source("../src/accounts.ts");
  // The identity server accepts 1–80 printable characters; the field stops there too.
  assert.match(accounts, /export const ACCOUNT_NAME_MAX = 80;/);
  for (const view of [self, other]) {
    assert.match(view, /value=\{nameDraft\}\s+maxLength=\{ACCOUNT_NAME_MAX\}/);
  }
  assert.match(self, /hint=\{tr\("settings\.account\.nameHint"\)\}/);
  assert.match(other, /hint=\{tr\("settings\.users\.nameHint"\)\}/);
  // The name is how agents and people address someone; the commit author is a separate Git profile.
  for (const key of ["settings.account.nameHint", "settings.users.nameHint"] as const) {
    assert.match(en[key], /Agents/);
    assert.match(en[key], /Git commits stays as it is/);
  }
});

test("anyone moves their own login and the owner moves others'; the hint says what stays", async () => {
  const self = await source("../src/components/settings/AccountDetail.tsx");
  const other = await source("../src/components/settings/UserDetail.tsx");
  const accounts = await source("../src/accounts.ts");
  // Same rule as identity `loginName`; the server stores it lowercase.
  assert.match(accounts, /export const ACCOUNT_LOGIN_MAX = 64;/);
  assert.match(accounts, /\/\^\[a-z0-9\]\[a-z0-9\._-\]\{0,63\}\$\/\.test\(normalizeLogin\(value\)\)/);
  assert.match(accounts, /"\/api\/auth\/me\/login"/);
  assert.match(accounts, /\/api\/auth\/accounts\/\$\{encodeURIComponent\(account\.id\)\}\/login/);
  // The lock screen offers the last login typed in this browser: it follows the move.
  assert.match(accounts, /if \(!account\.login \|\| currentBrowserLogin\(\) === account\.login\) rememberLogin\(next\);/);
  assert.match(self, /await changeCurrentLogin\(account, nextLogin\);/);
  assert.match(other, /changeAccountLogin\(account, nextLogin\)/);
  for (const view of [self, other]) {
    assert.match(view, /value=\{loginDraft\}\s+maxLength=\{ACCOUNT_LOGIN_MAX\}\s+autoComplete="off"\s+autoCapitalize="off"\s+spellCheck=\{false\}/);
    assert.match(view, /account\.managed \? \(\s*<ReadonlyRow label=\{tr\("settings\.users\.login"\)\}/);
    assert.match(view, /"settings\.users\.loginInvalid"/);
  }
  assert.match(en["settings.account.loginHint"], /passkeys and recovery codes work with the new one too\. Agents never see it\./);
  assert.match(en["settings.users.loginChangeHint"], /tell them the new login/);
  // A taken login reads as such, not as a stale revision.
  const model = await source("../src/components/settings/usersModel.ts");
  assert.match(model, /code === "login-taken"/);
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

test("a full-access paired phone reads Users and sends changes to a signed-in browser", async () => {
  const accounts = await source("../src/accounts.ts");
  assert.match(accounts, /readOnly: raw\.readOnly === true/);
  assert.match(accounts, /canManageInBrowser: raw\.readOnly === true && raw\.canManageInBrowser === true/);
  const users = await source("../src/components/settings/UsersPage.tsx");
  assert.match(users, /setReadOnly\(state\.readOnly \? \{ owner: state\.canManageInBrowser \} : null\)/);
  // No AccountDetail drill-in: its changes need a browser identity session.
  assert.match(users, /if \(ownOpen && self && !readOnly\)/);
  assert.match(users, /<div className="users-self-card is-readonly"/);
  assert.match(users, /tr\(readOnly \? "settings\.users\.selfHintBrowser" : "settings\.users\.selfHint"\)/);
  assert.match(users, /readOnly\?\.owner \? tr\("settings\.users\.manageInBrowser"\) : tr\("settings\.users\.peopleHintReadonly"\)/);
  assert.equal(en["settings.users.manageInBrowser"], "Add or change users in a browser signed in to this server.");
  assert.match(en["settings.users.selfHintBrowser"], /in a browser signed in to this server/);
  const styles = await source("../src/styles.css");
  assert.match(styles, /\.users-self-card\.is-readonly\s*\{[^}]*cursor:\s*default/);
  assert.match(styles, /\.users-self-card:hover:where\(:not\(:disabled, \.is-readonly\)\)/);
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
    assert.match(own, new RegExp(`title=\\{tr\\("${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)\\}`), title);
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

test("a signed-in row names the app shell from its token, never the browser it embeds", async () => {
  const own = await source("../src/components/settings/AccountDetail.tsx");
  // A phone app and phone Safari share one agent, and an Electron window
  // reports plain Chrome, so the appended token is the only shell signal.
  assert.match(own, /import \{ browserOf, isPhoneAgent, osOf, shellOf,/);
  assert.match(own, /const shell = shellOf\(ua\);/);
  // A shell's own agent never also reads as the browser it embeds.
  assert.match(own, /const browserName = shell \? null : browserOf\(ua\);/);
  assert.match(own, /isPhoneAgent\(session\.label\)/);
  const shells = {
    desktop: ["settings.accesspage.polythDesktop", "Polyth Desktop"],
    "desktop-workstation": ["settings.accesspage.polythDesktopWorkstation", "Polyth Desktop Workstation"],
    mobile: ["settings.accesspage.polythMobile", "Polyth Mobile"],
  } as const;
  for (const [kind, [key, label]] of Object.entries(shells)) {
    assert.match(own, new RegExp(`(?:^|\\s)"?${kind}"?: "${key.replace(/\./g, "\\.")}"`), kind);
    assert.equal(en[key as keyof typeof en], label);
  }
});
