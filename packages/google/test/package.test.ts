import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentCapabilityDescriptor, HarnessContext, JsonObject, RouteRequest, SpaceContext, SpaceRole } from "@polyth/contracts";
import { createCapabilityContributionRegistry } from "@polyth/harness-runtime";
import { assessPermissionRisk } from "@polyth/permissions";
import {
  bindPackageServices,
  createServerServiceRegistry,
  serverServiceKey,
  SPACE_SECURE_SAFE,
  type ServerPackageHost,
} from "@polyth/plugins";
import registerPackage from "../src/serverEntry.ts";
import { fakeGoogle, people, spaces, TEST_CLIENT_ID } from "./fakeGoogle.ts";

const SPACE = "spc_a";

function boot() {
  const capabilities = createCapabilityContributionRegistry();
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harness.capabilities"), capabilities);
  const tenancy = spaces();
  services.provide(SPACE_SECURE_SAFE, {
    forSpace: (space: SpaceContext) => tenancy.vault(space.spaceId),
    forSpaceId: (spaceId: string) => tenancy.vault(spaceId),
  } as never);
  const folks = people({ [SPACE]: ["usr_1", "usr_2", "usr_admin"] });
  const space = (spaceId: string, role: SpaceRole = "owner", userId = "usr_1"): SpaceContext => ({
    spaceId, spaceSlug: spaceId, userId, role, deployment: "local-trusted", storageDir: tenancy.storage(spaceId).root,
  });
  const host = {
    pluginId: "google",
    services: bindPackageServices(services, "google"),
    spaceStorage: (ctx: SpaceContext) => tenancy.storage(ctx.spaceId),
    systemSpaceContext: (spaceId: string) => space(spaceId),
    people: folks,
  } as unknown as ServerPackageHost;
  const value = registerPackage(host);
  const context = (spaceId: string): HarnessContext => ({ spaceId, projectId: "prj_1", cwd: mkdtempSync(join(tmpdir(), "google-cwd-")), sessionId: "ses_1" });
  const toolNames = (spaceId: string) => capabilities.resolve(context(spaceId))
    .filter((item): item is Extract<AgentCapabilityDescriptor, { kind: "tool" }> => item.kind === "tool")
    .map((item) => item.name);

  const call = async (path: string, method: string, body: JsonObject = {}, role: SpaceRole = "owner", userId = "usr_1") => {
    let status = 0;
    let payload: unknown;
    const handled = await value.routes!({
      path,
      method,
      url: new URL(`http://polyth.local${path}`),
      space: space(SPACE, role, userId),
      body: async () => body,
      json: (code: number, data: unknown) => { status = code; payload = data; },
    } as unknown as RouteRequest);
    return { handled, status, payload: payload as { ok: boolean; data?: Record<string, unknown>; error?: string; message?: string } };
  };
  return { value, capabilities, tenancy, folks, toolNames, call, context };
}

type Call = ReturnType<typeof boot>["call"];

/** Start a sign-in through the routes, approve it at the fake Google and paste the redirect back. */
async function signIn(call: Call, google: ReturnType<typeof fakeGoogle>, body: JsonObject, role: SpaceRole = "owner", userId = "usr_1") {
  const started = await call("/api/google/connect", "POST", body, role, userId);
  if (started.status !== 200) return started;
  const flow = started.payload.data as { state: string; url: string };
  const approved = google.approve(flow.url);
  return call(`/api/google/connect/${flow.state}/complete`, "POST", { url: `${new URL(approved.redirectUri).origin}/?state=${approved.state}&code=${approved.code}` }, role, userId);
}

const ALL_TOOLS = [
  "google_calendar_delete", "google_calendar_read", "google_calendar_send", "google_calendar_write",
  "google_drive_delete", "google_drive_read", "google_drive_share", "google_drive_upload", "google_drive_write",
  "google_gmail_manage", "google_gmail_read", "google_gmail_send",
];

test("tools appear once an OAuth client exists, and any member connects their own account", async (t) => {
  const google = fakeGoogle();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => google.fetch(String(input), init ?? {})) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const { value, capabilities, tenancy, folks, toolNames, call } = boot();
  await value.onEnable?.();
  t.after(() => value.onDisable?.());
  assert.deepEqual(value.remoteAccess, { routeScopes: ["google"], http: [] });

  const registered = capabilities.list().length + toolNames(SPACE).length;
  assert.equal(registered, 0, "contextual tools are neither listed statically nor resolved without an OAuth client");

  // Only an admin sets up the client.
  assert.equal((await call("/api/google/client", "PUT", { clientId: TEST_CLIENT_ID }, "member")).status, 403);
  assert.equal((await call("/api/google/client", "PUT", { clientId: TEST_CLIENT_ID, clientSecret: "desktop-secret" })).status, 200);
  // Visibility has no acting person: anyone in the Space may have connected, so every tool is offered and the call decides.
  assert.deepEqual(toolNames(SPACE), ALL_TOOLS);
  assert.deepEqual(toolNames("spc_b"), [], "another Space never sees this Space's tools");

  // A member who is not an admin connects their own account: identity first, then Gmail reading.
  const started = await call("/api/google/connect", "POST", { capabilities: [] }, "member", "usr_2");
  assert.equal(started.status, 200);
  assert.equal(new URL((started.payload.data as { url: string }).url).searchParams.get("scope"), "email openid profile");
  await call(`/api/google/connect/${(started.payload.data as { state: string }).state}`, "DELETE", {}, "member", "usr_2");
  const finished = await signIn(call, google, {}, "member", "usr_2");
  assert.equal((finished.payload.data as { status: string }).status, "completed");
  const mine = (await call("/api/google", "GET", {}, "member", "usr_2")).payload.data!;
  const accountId = (mine.accounts as Array<{ id: string; enabled: boolean }>)[0]!.id;
  assert.equal((mine.accounts as Array<{ enabled: boolean }>)[0]!.enabled, true, "connecting from a Space turns it on there");
  assert.equal(mine.canManage, false);

  const more = await call("/api/google/connect", "POST", { capabilities: ["gmail.read", "calendar.read", "calendar.write"], accountId }, "member", "usr_2");
  const moreFlow = more.payload.data as { state: string; url: string };
  assert.equal(new URL(moreFlow.url).searchParams.get("login_hint"), "ada@example.com");
  const second = google.approve(moreFlow.url);
  await call(`/api/google/connect/${moreFlow.state}/complete`, "POST", { url: `${new URL(second.redirectUri).origin}/?state=${second.state}&code=${second.code}` }, "member", "usr_2");
  assert.deepEqual(((await call("/api/google", "GET", {}, "member", "usr_2")).payload.data!.accounts as Array<{ capabilities: string[] }>)[0]!.capabilities, ["gmail.read", "calendar.read", "calendar.write"]);

  // A session's acting person sees only what an account they may use can serve.
  const actorTools = (actorUserId: string, sessionId: string | null = "ses_1") =>
    capabilities.resolve({ spaceId: SPACE, projectId: "prj_1", cwd: "/tmp", ...(sessionId ? { sessionId } : {}), actorUserId })
      .filter((item) => item.kind === "tool").map((item) => (item as { name: string }).name);
  assert.deepEqual(actorTools("usr_2"), ["google_calendar_delete", "google_calendar_read", "google_calendar_send", "google_calendar_write", "google_gmail_read"]);
  assert.deepEqual(actorTools("usr_1"), [], "no account of their own, no service account under policy");
  assert.deepEqual(actorTools("usr_9"), [], "a non-member is offered nothing");
  assert.deepEqual(actorTools("usr_1", null), ALL_TOOLS, "a runtime shared across sessions has no acting person");

  // Nobody else sees it, not even an admin.
  const other = (await call("/api/google", "GET", {}, "owner", "usr_1")).payload;
  assert.doesNotMatch(JSON.stringify(other), /ada@example\.com/);
  // Another person cannot reauthorize, toggle or remove it.
  assert.equal((await call("/api/google/connect", "POST", { accountId }, "owner", "usr_1")).status, 404);
  assert.equal((await call(`/api/google/accounts/${accountId}`, "PUT", { enabled: false }, "owner", "usr_1")).status, 404);
  assert.equal((await call(`/api/google/accounts/${accountId}`, "DELETE", {}, "owner", "usr_1")).status, 404);

  const descriptors = capabilities.resolve({ spaceId: SPACE, projectId: "prj_1", cwd: "/tmp", sessionId: "ses_1" })
    .filter((item): item is Extract<AgentCapabilityDescriptor, { kind: "tool" }> => item.kind === "tool");
  for (const tool of descriptors) {
    assert.equal(tool.trust, "credentialed", `${tool.name} is never auto-allowed as pure`);
    assert.equal(tool.mutating, !tool.name.endsWith("_read"), `${tool.name} mutating flag`);
  }

  // The secret is in the person's vault, not the Space's.
  assert.equal(tenancy.vaults.get(SPACE)!.values.has("google:spc_a:account:1001"), false);
  assert.match(JSON.stringify([...folks.vaults.get("usr_2")!.values.keys()]), /account:1001/);
  const snapshot = JSON.stringify((await call("/api/google", "GET", {}, "member", "usr_2")).payload);
  assert.doesNotMatch(snapshot, /refresh-|access-|desktop-secret/);
});

test("permission risk holds outbound and irreversible Google tools for a person", () => {
  const risk = (id: string, name: string) => assessPermissionRisk({ permission: "package-tool", patterns: [id], tool: name }).risk;
  assert.equal(risk("google.gmail-send", "google_gmail_send"), "high");
  assert.equal(risk("google.drive-share", "google_drive_share"), "high");
  assert.equal(risk("google.drive-upload", "google_drive_upload"), "high");
  assert.equal(risk("google.drive-delete", "google_drive_delete"), "high");
  assert.equal(risk("google.calendar-delete", "google_calendar_delete"), "high");
  assert.equal(risk("google.calendar-send", "google_calendar_send"), "high");
  assert.equal(risk("google.gmail-manage", "google_gmail_manage"), "medium");
  assert.equal(risk("google.calendar-write", "google_calendar_write"), "medium");
  assert.equal(risk("google.drive-write", "google_drive_write"), "medium");
  assert.equal(risk("google.gmail-read", "google_gmail_read"), "medium");
});

test("tool calls act only for the person who sent the turn and stop after they disconnect", async (t) => {
  const google = fakeGoogle();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => google.fetch(String(input), init ?? {})) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const { value, capabilities, call } = boot();
  await value.onEnable?.();
  t.after(() => value.onDisable?.());
  await call("/api/google/client", "PUT", { clientId: TEST_CLIENT_ID, clientSecret: "desktop-secret" });
  await signIn(call, google, { capabilities: ["drive.read"] }, "member", "usr_1");

  const execute = capabilities.contribution("google.drive-read")!.execute!;
  const ctx = { sessionId: "ses_1", projectId: "prj_1", cwd: tmpdir(), spaceId: SPACE, actorUserId: "usr_1" };
  const read = JSON.parse((await execute({ action: "get", fileId: "abc" }, ctx)).output) as { account: string };
  assert.equal(read.account, "ada@example.com");
  await assert.rejects(execute({ action: "get", fileId: "abc" }, { ...ctx, spaceId: undefined }), /^Error: permission-denied:/);
  await assert.rejects(execute({ action: "explode" }, ctx), /^Error: invalid-request: action must be one of/);
  // Another member, system work, a non-member and a foreign Space: refused, without naming the account.
  const refusedWithout = (pattern: RegExp) => (error: Error) => pattern.test(error.message) && !/ada@example\.com/.test(error.message);
  await assert.rejects(execute({ action: "get", fileId: "abc" }, { ...ctx, actorUserId: "usr_2" }), refusedWithout(/^not-connected: Connect your Google account in Settings → Google/));
  await assert.rejects(execute({ action: "get", fileId: "abc", account: "ada@example.com" }, { ...ctx, actorUserId: "usr_2" }), refusedWithout(/^not-connected:/));
  await assert.rejects(execute({ action: "get", fileId: "abc" }, { ...ctx, actorUserId: undefined }), refusedWithout(/^not-connected: No person started this turn/));
  await assert.rejects(execute({ action: "get", fileId: "abc" }, { ...ctx, actorUserId: "usr_stranger" }), refusedWithout(/^permission-denied:/));
  await assert.rejects(execute({ action: "get", fileId: "abc" }, { ...ctx, spaceId: "spc_b" }), refusedWithout(/^permission-denied:/));
  await assert.rejects(execute({ action: "get", fileId: "abc", account: "eve@example.com" }, ctx), /^Error: not-connected: None of the Google accounts you can use here matches/);

  // Turned off in this Space: the agent is refused until the person turns it back on.
  assert.equal(((await call("/api/google/accounts/1001", "PUT", { enabled: false }, "member", "usr_1")).payload.data as { enabled: boolean }).enabled, false);
  await assert.rejects(execute({ action: "get", fileId: "abc" }, ctx), /^Error: not-connected: Connect your Google account/);
  assert.equal((await call("/api/google/accounts/1001", "PUT", { enabled: "yes" }, "member", "usr_1")).payload.error, "invalid-request");
  await call("/api/google/accounts/1001", "PUT", { enabled: true }, "member", "usr_1");

  const removed = await call("/api/google/accounts/1001", "DELETE", {}, "member", "usr_1");
  assert.deepEqual(removed.payload.data, { removed: true, revoked: true });
  // A session that still holds the old tool gets a clear error instead of access.
  await assert.rejects(execute({ action: "get", fileId: "abc" }, ctx), /^Error: not-connected: Connect your Google account/);
  assert.equal((await call("/api/google/accounts/1001", "DELETE", {}, "member", "usr_1")).status, 404);
  assert.equal((await call("/api/google/connect", "POST", { capabilities: ["gmail.everything"] })).payload.error, "invalid-request");
  assert.equal((await call("/api/google/connect", "POST", { owner: "everyone" })).payload.error, "invalid-request");
});

test("Space service accounts are admin-managed, shown to members only as a label, and used by agents only under policy", async (t) => {
  const google = fakeGoogle({ user: { sub: "3003", email: "team@example.com", name: "Team" } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => google.fetch(String(input), init ?? {})) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const { value, capabilities, toolNames, call } = boot();
  await value.onEnable?.();
  t.after(() => value.onDisable?.());
  await call("/api/google/client", "PUT", { clientId: TEST_CLIENT_ID, clientSecret: "desktop-secret" });

  assert.equal((await call("/api/google/connect", "POST", { owner: "space" }, "member", "usr_2")).status, 403);
  const done = await signIn(call, google, { owner: "space", capabilities: ["drive.read"] }, "admin", "usr_admin");
  assert.equal((done.payload.data as { status: string }).status, "completed");
  await call("/api/google/client", "DELETE");
  assert.deepEqual(toolNames(SPACE), ["google_drive_read"], "without a client only the service account's grants are offered");

  const adminView = (await call("/api/google", "GET", {}, "admin", "usr_admin")).payload.data!;
  assert.equal((adminView.service as Array<{ email: string }>)[0]!.email, "team@example.com");
  assert.deepEqual(adminView.accounts, [], "a service account is nobody's personal account");
  assert.deepEqual(adminView.policy, { agentsMayUseService: false });
  const memberView = (await call("/api/google", "GET", {}, "member", "usr_2")).payload.data!;
  assert.deepEqual(memberView.service, [{ label: "Team", status: "connected", capabilities: ["drive.read"] }]);
  assert.doesNotMatch(JSON.stringify(memberView), /team@example\.com|3003/);

  const execute = capabilities.contribution("google.drive-read")!.execute!;
  const ctx = { sessionId: "ses_1", projectId: "prj_1", cwd: tmpdir(), spaceId: SPACE, actorUserId: "usr_2" };
  await assert.rejects(execute({ action: "get", fileId: "abc" }, ctx), /^Error: not-connected: Connect your Google account/);
  await assert.rejects(execute({ action: "get", fileId: "abc" }, { ...ctx, actorUserId: undefined }), /^Error: not-connected: No person started this turn/);

  assert.equal((await call("/api/google/policy", "PUT", { agentsMayUseService: true }, "member", "usr_2")).status, 403);
  assert.equal((await call("/api/google/policy", "PUT", { agentsMayUseService: "yes" }, "admin", "usr_admin")).payload.error, "invalid-request");
  assert.deepEqual((await call("/api/google/policy", "PUT", { agentsMayUseService: true }, "admin", "usr_admin")).payload.data, { agentsMayUseService: true });
  assert.equal((JSON.parse((await execute({ action: "get", fileId: "abc" }, ctx)).output) as { account: string }).account, "team@example.com");
  assert.equal((JSON.parse((await execute({ action: "get", fileId: "abc" }, { ...ctx, actorUserId: undefined })).output) as { account: string }).account, "team@example.com");

  // Members cannot remove it; an admin can, through the service route only.
  assert.equal((await call("/api/google/service-accounts/3003", "DELETE", {}, "member", "usr_2")).status, 403);
  assert.equal((await call("/api/google/accounts/3003", "DELETE", {}, "admin", "usr_admin")).status, 404);
  assert.deepEqual((await call("/api/google/service-accounts/3003", "DELETE", {}, "admin", "usr_admin")).payload.data, { removed: true, revoked: true });
  assert.deepEqual(toolNames(SPACE), []);
});

test("with Polyth's built-in app one consent gives calendar, send-only mail and agent-created Drive files", async (t) => {
  const google = fakeGoogle();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => google.fetch(String(input), init ?? {})) as typeof fetch;
  const env = ["POLYTH_GOOGLE_CLIENT_ID", "POLYTH_GOOGLE_BUILTIN_CLIENT_ID", "POLYTH_GOOGLE_BUILTIN_CLIENT_SECRET"].map((name) => [name, process.env[name]] as const);
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of env) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.POLYTH_GOOGLE_CLIENT_ID;
  process.env.POLYTH_GOOGLE_BUILTIN_CLIENT_ID = TEST_CLIENT_ID;
  process.env.POLYTH_GOOGLE_BUILTIN_CLIENT_SECRET = "builtin-secret";
  const { value, capabilities, toolNames, call } = boot();
  await value.onEnable?.();
  t.after(() => value.onDisable?.());

  const client = (await call("/api/google", "GET")).payload.data!.client as { source: string; capabilities: string[] };
  assert.equal(client.source, "builtin");
  assert.deepEqual(client.capabilities, ["calendar.read", "calendar.write", "gmail.send", "drive.file"]);
  const refused = await call("/api/google/connect", "POST", { capabilities: ["gmail.read"] });
  assert.equal(refused.status, 400);
  assert.match(refused.payload.message ?? "", /your own Google Cloud client/);

  const flow = (await call("/api/google/connect", "POST", { capabilities: client.capabilities })).payload.data as { state: string; url: string };
  const SCOPE = "https://www.googleapis.com/auth/";
  assert.equal(new URL(flow.url).searchParams.get("scope"), `email ${SCOPE}calendar.events ${SCOPE}calendar.readonly ${SCOPE}drive.file ${SCOPE}gmail.send openid profile`);
  const approved = google.approve(flow.url);
  await call(`/api/google/connect/${flow.state}/complete`, "POST", { url: `${new URL(approved.redirectUri).origin}/?state=${approved.state}&code=${approved.code}` });
  assert.deepEqual(toolNames(SPACE), [
    "google_calendar_delete", "google_calendar_read", "google_calendar_send", "google_calendar_write",
    "google_drive_delete", "google_drive_read", "google_drive_share", "google_drive_upload", "google_drive_write",
    "google_gmail_send",
  ]);

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  google.handleApi((url) => {
    if (url.pathname.endsWith("/messages/send")) return json({ id: "sent-1", threadId: "thread-1", labelIds: ["SENT"] });
    if (url.pathname.endsWith("/files/made-by-agent")) return json({ id: "made-by-agent", name: "Notes", mimeType: "text/plain" });
    return undefined;
  });
  // The person who connected the account acts in the turn.
  const ctx = { sessionId: "ses_1", projectId: "prj_1", cwd: tmpdir(), spaceId: SPACE, actorUserId: "usr_1" };
  const send = capabilities.contribution("google.gmail-send")!.execute!;
  const sent = await send({ action: "send", to: ["bob@example.com"], subject: "Hi", body: "Hello" }, ctx);
  assert.match(sent.output, /"id":"sent-1"/);
  // Replies read the original message, which send-only access cannot do.
  await assert.rejects(send({ action: "reply", messageId: "m1", body: "Thanks" }, ctx), /^Error: insufficient-scope: .*gmail\.write/);
  const file = await capabilities.contribution("google.drive-read")!.execute!({ action: "get", fileId: "made-by-agent" }, ctx);
  assert.match(file.output, /"name":"Notes"/);
});

test("disable removes tools and routes; enable is idempotent", async () => {
  const { value, capabilities, tenancy } = boot();
  await value.onEnable?.();
  await value.onEnable?.();
  const storage = tenancy.storage(SPACE);
  const ids = capabilities.resolve({ spaceId: SPACE, projectId: "p", cwd: "/tmp" }).length;
  assert.equal(ids, 0);
  await value.onDisable?.();
  const after = await value.routes!({ path: "/api/google", method: "GET" } as unknown as RouteRequest);
  assert.equal(after, false);
  assert.throws(() => readFileSync(join(storage.packageDir("google"), "accounts.json")), /ENOENT/);
});

test("routine tools refuse changes that would reach other people", async (t) => {
  const google = fakeGoogle();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => google.fetch(String(input), init ?? {})) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const { value, capabilities, call } = boot();
  await value.onEnable?.();
  t.after(() => value.onDisable?.());
  await call("/api/google/client", "PUT", { clientId: TEST_CLIENT_ID, clientSecret: "desktop-secret" });
  await signIn(call, google, { capabilities: ["calendar.read", "calendar.write", "drive.read", "drive.write"] });

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const writes: string[] = [];
  google.handleApi((url, init) => {
    if ((init.method ?? "GET") !== "GET") writes.push(`${init.method} ${url.pathname}`);
    if (url.pathname.endsWith("/events/meeting")) {
      return json({ id: "meeting", status: "confirmed", start: { dateTime: "2026-10-07T09:00:00+03:00" }, end: { dateTime: "2026-10-07T10:00:00+03:00" }, attendees: [{ email: "ada@example.com", self: true }, { email: "eve@evil.test" }] });
    }
    if (url.pathname.endsWith("/files/shared-folder")) return json({ id: "shared-folder", name: "Team", mimeType: "application/vnd.google-apps.folder", shared: true });
    if (url.pathname.endsWith("/files/private-folder")) return json({ id: "private-folder", name: "Mine", mimeType: "application/vnd.google-apps.folder", shared: false });
    if (url.pathname.endsWith("/files/doc")) return json({ id: "doc", name: "Doc", mimeType: "text/plain", parents: ["root"] });
    return undefined;
  });
  const ctx = { sessionId: "ses_1", projectId: "prj_1", cwd: tmpdir(), spaceId: SPACE, actorUserId: "usr_1" };
  const calendarWrite = capabilities.contribution("google.calendar-write")!.execute!;
  const event = { summary: "Sync", start: { dateTime: "2026-10-07T09:00:00+03:00" }, end: { dateTime: "2026-10-07T10:00:00+03:00" } };
  await assert.rejects(calendarWrite({ action: "create", event: { ...event, attendees: [{ email: "eve@evil.test" }] } }, ctx), /^Error: invalid-request: Events with guests are created with google_calendar_send/);
  await assert.rejects(calendarWrite({ action: "update", eventId: "meeting", patch: { description: "secrets" } }, ctx), /^Error: invalid-request: This event has guests/);
  await assert.rejects(calendarWrite({ action: "update", eventId: "solo", addAttendees: [{ email: "eve@evil.test" }] }, ctx), /^Error: invalid-request: Changing guests/);

  const driveWrite = capabilities.contribution("google.drive-write")!.execute!;
  await assert.rejects(driveWrite({ action: "move", fileId: "doc", folderId: "shared-folder" }, ctx), /^Error: invalid-request: Team is shared with other people/);
  await assert.rejects(driveWrite({ action: "copy", fileId: "doc", parentId: "shared-folder" }, ctx), /google_drive_share/);
  assert.deepEqual(writes, [], "nothing reached Google");
  await driveWrite({ action: "move", fileId: "doc", folderId: "private-folder" }, ctx);
  assert.deepEqual(writes, ["PATCH /drive/v3/files/doc"]);
});
