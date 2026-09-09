import { readFileSync, writeFileSync } from "node:fs";

const OWNER = "usr_owner";

function file(path) {
  let text = readFileSync(path, "utf8");
  const original = text;
  const once = (from, to, label = from.slice(0, 80)) => {
    const first = text.indexOf(from);
    if (first < 0) throw new Error(`${path}: missing ${label}`);
    if (text.indexOf(from, first + from.length) >= 0) throw new Error(`${path}: ambiguous ${label}`);
    text = text.slice(0, first) + to + text.slice(first + from.length);
  };
  const all = (from, to, expected, label = from.slice(0, 80)) => {
    const parts = text.split(from);
    if (parts.length - 1 !== expected) throw new Error(`${path}: expected ${expected} ${label}, got ${parts.length - 1}`);
    text = parts.join(to);
  };
  const regex = (pattern, replacement, expected = 1, label = String(pattern)) => {
    let count = 0;
    text = text.replace(pattern, (...args) => {
      count += 1;
      return typeof replacement === "function" ? replacement(...args) : replacement;
    });
    if (count !== expected) throw new Error(`${path}: expected ${expected} ${label}, got ${count}`);
  };
  const done = () => {
    if (text === original) throw new Error(`${path}: no changes`);
    writeFileSync(path, text);
  };
  return { once, all, regex, done };
}

// Durable Agent presets: existing rows are adopted by the bootstrap owner;
// every new read/write is explicitly account scoped.
{
  const p = file("packages/session/src/index.ts");
  p.once(
    "const PROMPT_HISTORY_CHUNK = 32;\n",
    `const PROMPT_HISTORY_CHUNK = 32;\nconst OWNER_USER_ID = ${JSON.stringify(OWNER)};\n`,
    "profile owner constant",
  );
  p.once(
    `  profileList(): Promise<AgentProfile[]>;\n  profileGet(id: string): Promise<AgentProfile | undefined>;\n  profileCreate(input: Omit<AgentProfile, \"id\" | \"revision\" | \"createdAt\" | \"updatedAt\">): Promise<AgentProfile>;\n  /** Stale expectedRevision → conflict. providerID/modelID stay immutable per profile. */\n  profileUpdate(id: string, patch: Partial<Omit<AgentProfile, \"id\" | \"revision\" | \"createdAt\" | \"updatedAt\">>, expectedRevision: number): Promise<AgentProfile>;\n  profileRemove(id: string): Promise<boolean>;`,
    `  profileList(userId?: string): Promise<AgentProfile[]>;\n  profileGet(id: string, userId?: string): Promise<AgentProfile | undefined>;\n  profileCreate(input: Omit<AgentProfile, \"id\" | \"revision\" | \"createdAt\" | \"updatedAt\">, userId?: string): Promise<AgentProfile>;\n  /** Stale expectedRevision → conflict. providerID/modelID stay immutable per profile. */\n  profileUpdate(id: string, patch: Partial<Omit<AgentProfile, \"id\" | \"revision\" | \"createdAt\" | \"updatedAt\">>, expectedRevision: number, userId?: string): Promise<AgentProfile>;\n  profileRemove(id: string, userId?: string): Promise<boolean>;`,
    "profile store contract",
  );
  p.once(
    `    // v12: authoritative profile routes are harness-qualified. Existing rows\n    // remain NULL because their origin cannot be proven from provider/model\n    // strings alone; new exact profiles always write a harness id.\n    () => {\n      sqliteExec(\"ALTER TABLE agent_profiles ADD COLUMN harness_id TEXT\");\n    },`,
    `    // v12: authoritative profile routes are harness-qualified. Existing rows\n    // remain NULL because their origin cannot be proven from provider/model\n    // strings alone; new exact profiles always write a harness id.\n    () => {\n      sqliteExec(\"ALTER TABLE agent_profiles ADD COLUMN harness_id TEXT\");\n    },\n    // v13: Agent presets are user-owned. Legacy rows belonged to the only\n    // account that existed, so adopt them to the bootstrap owner in-place.\n    () => {\n      sqliteExec(\"ALTER TABLE agent_profiles ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'usr_owner'\");\n      sqliteExec(\"CREATE INDEX IF NOT EXISTS idx_agent_profiles_owner ON agent_profiles (owner_user_id, name)\");\n    },`,
    "agent profile owner migration",
  );
  p.once(
    "    id: string; name: string; provider_id: string; model_id: string;",
    "    id: string; owner_user_id: string; name: string; provider_id: string; model_id: string;",
    "profile row owner",
  );
  p.once(
    `  const profileRow = (id: string): ProfileRow | undefined =>\n    sqlitePrepare(\"SELECT * FROM agent_profiles WHERE id = ?\").get(id) as unknown as ProfileRow | undefined;\n\n  async function profileList(): Promise<AgentProfile[]> {\n    const rows = sqlitePrepare(\"SELECT * FROM agent_profiles ORDER BY name\").all() as unknown as ProfileRow[];\n    return rows.map(rowToProfile);\n  }\n\n  async function profileGet(id: string): Promise<AgentProfile | undefined> {\n    const row = profileRow(id);\n    return row ? rowToProfile(row) : undefined;\n  }`,
    `  const profileRow = (id: string, userId = OWNER_USER_ID): ProfileRow | undefined =>\n    sqlitePrepare(\"SELECT * FROM agent_profiles WHERE id = ? AND owner_user_id = ?\").get(id, userId) as unknown as ProfileRow | undefined;\n\n  async function profileList(userId = OWNER_USER_ID): Promise<AgentProfile[]> {\n    const rows = sqlitePrepare(\"SELECT * FROM agent_profiles WHERE owner_user_id = ? ORDER BY name\").all(userId) as unknown as ProfileRow[];\n    return rows.map(rowToProfile);\n  }\n\n  async function profileGet(id: string, userId = OWNER_USER_ID): Promise<AgentProfile | undefined> {\n    const row = profileRow(id, userId);\n    return row ? rowToProfile(row) : undefined;\n  }`,
    "profile account queries",
  );
  p.once(
    `  async function profileCreate(\n    input: Omit<AgentProfile, \"id\" | \"revision\" | \"createdAt\" | \"updatedAt\">,\n  ): Promise<AgentProfile> {`,
    `  async function profileCreate(\n    input: Omit<AgentProfile, \"id\" | \"revision\" | \"createdAt\" | \"updatedAt\">,\n    userId = OWNER_USER_ID,\n  ): Promise<AgentProfile> {`,
    "profile create owner",
  );
  p.once(
    `      \`INSERT INTO agent_profiles (id, name, harness_id, provider_id, model_id, agent, mode, thinking, features, notes, icon, color, revision, created_at, updated_at)\n       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)\`,\n    ).run(\n      id, name, input.harnessId ?? \"opencode\", input.providerID, input.modelID,`,
    `      \`INSERT INTO agent_profiles (id, owner_user_id, name, harness_id, provider_id, model_id, agent, mode, thinking, features, notes, icon, color, revision, created_at, updated_at)\n       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)\`,\n    ).run(\n      id, userId, name, input.harnessId ?? \"opencode\", input.providerID, input.modelID,`,
    "profile insert owner",
  );
  p.regex(
    /return rowToProfile\(profileRow\(id\)!\);/g,
    "return rowToProfile(profileRow(id, userId)!);",
    2,
    "profile create/update returns",
  );
  p.once(
    `  async function profileUpdate(\n    id: string,\n    patch: Partial<Omit<AgentProfile, \"id\" | \"revision\" | \"createdAt\" | \"updatedAt\">>,\n    expectedRevision: number,\n  ): Promise<AgentProfile> {`,
    `  async function profileUpdate(\n    id: string,\n    patch: Partial<Omit<AgentProfile, \"id\" | \"revision\" | \"createdAt\" | \"updatedAt\">>,\n    expectedRevision: number,\n    userId = OWNER_USER_ID,\n  ): Promise<AgentProfile> {`,
    "profile update owner",
  );
  p.regex(
    /(async function profileUpdate[\s\S]*?return transaction\(\(\) => \{\n\s*)const row = profileRow\(id\);/,
    "$1const row = profileRow(id, userId);",
    1,
    "profile update scoped row",
  );
  p.once(
    `  async function profileRemove(id: string): Promise<boolean> {\n    const res = sqlitePrepare(\"DELETE FROM agent_profiles WHERE id = ?\").run(id);\n    return Number(res.changes) > 0;\n  }`,
    `  async function profileRemove(id: string, userId = OWNER_USER_ID): Promise<boolean> {\n    const res = sqlitePrepare(\"DELETE FROM agent_profiles WHERE id = ? AND owner_user_id = ?\").run(id, userId);\n    return Number(res.changes) > 0;\n  }`,
    "profile delete owner",
  );
  p.done();
}

// Session execution may resolve an account-owned preset, but the preset id is
// not a shared session fact. Persist only the resolved model/agent.
{
  const p = file("packages/server/src/sessions.ts");
  p.once(
    `  /** Agent-profile lookup (WP8) — profiles resolve to explicit model/agent at send time. */\n  profiles?: { profileGet(id: string): Promise<AgentProfile | undefined> };`,
    `  /** Account-owned Agent-preset lookup. Presets resolve to explicit execution choices at send time. */\n  profiles?: { profileGet(id: string, userId?: string): Promise<AgentProfile | undefined> };`,
    "session preset dependency",
  );
  p.regex(
    /\n  \/\/ UX-COMPOSER-DISC: the projection records the selected profile id or its\n  \/\/ explicit clear; spread-merge cannot delete a key, so this owns removal\.\n  const setProjectionProfile = async \(sessionId: string, id: string \| undefined\) => \{[\s\S]*?\n  \};\n/,
    "\n",
    1,
    "remove shared preset projection helper",
  );
  p.once(
    `      const projectProfileId = project.defaults?.agentProfileId ?? undefined;\n      const projectProfile = projectProfileId ? await deps.profiles?.profileGet(projectProfileId) : undefined;\n      // Stored profiles from before harness qualification retain a NULL\n      // harness. Their original catalog was OpenCode-owned, so preserve that\n      // compatibility without rewriting the row until the user edits it.\n      const projectProfileHarnessId = projectProfile ? projectProfile.harnessId ?? \"opencode\" : undefined;\n      const requestedHarness = input.harness;\n      const harness = requestedHarness?.mode === \"pinned\"\n        ? requestedHarness\n        : projectProfileHarnessId\n          ? { mode: \"pinned\" as const, harnessId: projectProfileHarnessId }\n          : requestedHarness ?? project.defaults?.harness ?? { mode: \"auto\" as const };\n      const compatibleProjectProfile = projectProfile && (harness.mode === \"auto\"\n        || projectProfileHarnessId === harness.harnessId)\n        ? projectProfile\n        : undefined;\n      input = { ...input, harness };`,
    `      const requestedHarness = input.harness;\n      const harness = requestedHarness ?? project.defaults?.harness ?? { mode: \"auto\" as const };\n      input = { ...input, harness };`,
    "remove project-shared preset default",
  );
  p.once(
    `        ...(compatibleProjectProfile ? { agentProfileId: compatibleProjectProfile.id } : {}),\n`,
    "",
    "remove preset id from new projection",
  );
  p.once(
    `      const profile = projection.agentProfileId ? await deps.profiles?.profileGet(projection.agentProfileId) : undefined;\n      const agentIntent = profile ? [profile.name, profile.notes].filter(Boolean).join(\": \") : projection.runtimeLeg?.agentIntent ?? projection.agent;`,
    `      const agentIntent = projection.runtimeLeg?.agentIntent ?? projection.agent;`,
    "remove preset from harness switch",
  );
  p.once(
    `    async send(sessionId, input: UserTurnInput): Promise<SendResult> {\n      let proj = await store.projection(sessionId);`,
    `    async send(sessionId, input: UserTurnInput): Promise<SendResult> {\n      const accountUserId = (input as UserTurnInput & { accountUserId?: string }).accountUserId ?? OWNER_USER_ID;\n      let proj = await store.projection(sessionId);`,
    "capture account in send",
  );
  // Reuse the same stable owner fallback as the durable preset store.
  p.once(
    `const QUIET_DISPATCH_ERRORS = new Set([`,
    `const OWNER_USER_ID = ${JSON.stringify(OWNER)};\nconst QUIET_DISPATCH_ERRORS = new Set([`,
    "session owner constant",
  );
  p.regex(
    /      \/\/ Atomic profile application:[\s\S]*?      await requireLaunchModelForAutoAgent\(rt, input\.agent \?\? proj\.agent, input\.model \?\? proj\.model\);/,
    `      // Agent presets are account-owned convenience. Resolve the selected\n      // preset under the server-owned account identity and persist only its\n      // effective model/agent, never the private preset id.\n      const requestedPresetId = typeof input.agentProfileId === \"string\" && input.agentProfileId\n        ? input.agentProfileId\n        : undefined;\n      if (requestedPresetId) {\n        const preset = await deps.profiles?.profileGet(requestedPresetId, accountUserId);\n        if (!preset) throw Object.assign(new Error(\"agent preset not found\"), { code: \"not-found\" });\n        const { agentProfileId: _privatePresetId, ...rest } = input;\n        input = {\n          ...rest,\n          model: input.model ?? { providerID: preset.providerID, modelID: preset.modelID },\n          ...(input.agent ?? preset.agent ? { agent: input.agent ?? preset.agent } : {}),\n        };\n      } else if (input.agentProfileId !== undefined) {\n        const { agentProfileId: _privatePresetId, ...rest } = input;\n        input = rest;\n      }\n      await requireLaunchModelForAutoAgent(rt, input.agent ?? proj.agent, input.model ?? proj.model);`,
    1,
    "account scoped preset send",
  );
  p.done();
}

// Composer: presets stay a dedicated composer control and never live inside
// the model picker's header/context. Favorites no longer manufacture presets.
{
  const p = file("apps/web/src/components/Composer.tsx");
  p.once(
    `import { migrateFavoritesOnce, profilesLoaded, useProfiles } from \"../profiles.ts\";`,
    `import { profilesLoaded, useProfiles } from \"../profiles.ts\";`,
    "remove favorites preset migration import",
  );
  p.once(
    `  // One-time favorites → profiles migration once models are known.\n  useEffect(() => {\n    if (models.length > 0) void migrateFavoritesOnce(models);\n  }, [models]);\n\n`,
    "",
    "remove favorites preset migration effect",
  );
  p.once(
    `    executionAgentControl: agentControl,\n    executionEffortControl: effortControl,\n    executionProfileControl: profileControl,\n    phoneLayout,`,
    `    executionAgentControl: agentControl,\n    executionEffortControl: effortControl,\n    phoneLayout,`,
    "remove preset from model picker context",
  );
  p.once(
    `  const inheritedProfile = activeProject?.defaults?.agentProfileId\n    ? profiles.find((profile) => profile.id === activeProject.defaults?.agentProfileId)\n    : undefined;\n`,
    "",
    "remove shared project preset inheritance",
  );
  p.once(
    `    { id: \"\", label: inheritedProfile ? \`Default: \${inheritedProfile.name}\` : \"Default\", group: \"\" },`,
    `    { id: \"\", label: \"Default\", group: \"\" },`,
    "preset default label",
  );
  p.once(`    label=\"Profile\"`, `    label=\"Agent preset\"`, "preset control label");
  p.once(
    `    placeholder={profileItems.find((item) => item.id === profileValue)?.label ?? \"Profile\"}`,
    `    placeholder={profileItems.find((item) => item.id === profileValue)?.label ?? \"Preset\"}`,
    "preset placeholder",
  );
  p.once(
    `    ariaLabel={\`Select profile, current: \${profileItems.find((item) => item.id === profileValue)?.label ?? \"Default\"}\`}`,
    `    ariaLabel={\`Select agent preset, current: \${profileItems.find((item) => item.id === profileValue)?.label ?? \"Default\"}\`}`,
    "preset aria label",
  );
  p.once(
    `        <span className=\"composer-execution\">\n          {phoneLayout && modelControl}\n          <SlotHost slot=\"composer.execution\" context={slotContext} />`,
    `        <span className=\"composer-execution\">\n          {phoneLayout && profileControl}\n          {phoneLayout && modelControl}\n          <SlotHost slot=\"composer.execution\" context={slotContext} />`,
    "phone preset placement",
  );
  p.once(
    `          <div className=\"composer-config\">\n            {!phoneLayout && modelControl}\n          </div>`,
    `          <div className=\"composer-config\">\n            {!phoneLayout && profileControl}\n            {!phoneLayout && modelControl}\n          </div>`,
    "desktop preset placement",
  );
  p.done();
}

// Settings: presets are account-level; projects no longer persist a private
// preset id. Expose Accounts & Access in the actual Settings navigation.
{
  const p = file("apps/web/src/components/settings/pages.tsx");
  p.regex(
    /(export function ProjectsPage\(\) \{[\s\S]*?const sessionDefaults = useSessionDefaults\(\);\n)  const profiles = useProfiles\(\);\n/,
    "$1",
    1,
    "remove project preset list",
  );
  p.once(
    `  const saveExecution = async (projectId: string, patch: { harness?: HarnessSelection | null; agentProfileId?: string | null }) => {`,
    `  const saveExecution = async (projectId: string, patch: { harness?: HarnessSelection | null }) => {`,
    "project execution patch contract",
  );
  p.regex(
    /          <div className="project-settings-options" data-settings-item="projects\.executionProfile">[\s\S]*?          <\/div>\n          \{projectRemembersModelSelection/,
    "          {projectRemembersModelSelection",
    1,
    "remove project default preset UI",
  );
  p.once(
    `<PageHead title="Profiles" blurb="Bundle a harness, model, native role, thinking level, and feature choices for repeatable execution." />`,
    `<PageHead title="Agent presets" blurb="Reusable harness, model, native role, thinking, and feature choices owned by the current account." />`,
    "preset settings title",
  );
  p.once(
    `<span>{profiles.length} profile{profiles.length === 1 ? "" : "s"}</span>`,
    `<span>{profiles.length} preset{profiles.length === 1 ? "" : "s"}</span>`,
    "preset count",
  );
  p.once(`>New profile</Button>`, `>New preset</Button>`, "new preset label");
  p.once(
    `<EmptyState title="No profiles yet" body="Create a profile for execution choices you use together." />`,
    `<EmptyState title="No presets yet" body="Create an Agent preset for execution choices you use together." />`,
    "empty presets",
  );
  p.once(
    `Delete profile ${"${profile.name}"}?`,
    `Delete preset ${"${profile.name}"}?`,
    "delete preset wording",
  );
  p.done();
}

{
  const p = file("apps/web/src/components/SettingsView.tsx");
  p.once(
    `{ id: "profiles", label: "Profiles", group: "Engineering", render: () => <ProfilesPage /> },`,
    `{ id: "profiles", label: "Agent presets", group: "Engineering", render: () => <ProfilesPage /> },`,
    "preset navigation label",
  );
  p.once(
    `{ id: "access", label: tr("settingsview.access"), group: "System", nav: false, render: () => <AccessPage /> },`,
    `{ id: "access", label: tr("settingsview.access"), group: "System", render: () => <AccessPage /> },`,
    "show Access navigation",
  );
  p.done();
}

// Pairing ownership: pairings and resulting devices are bound to the account
// that initiated them. Legacy devices belonged to the bootstrap owner.
{
  const p = file("packages/tunnel/src/index.ts");
  p.once(
    `  id: string;\n  endpointId: string;`,
    `  id: string;\n  userId: string;\n  endpointId: string;`,
    "tunnel device user",
  );
  p.once(
    `    if (!columns.has(\"pairing_state\")) this.db.exec(\"ALTER TABLE tunnel_device ADD COLUMN pairing_state TEXT NOT NULL DEFAULT 'active'\");\n    this.db.exec(\"CREATE UNIQUE INDEX IF NOT EXISTS tunnel_device_pairing_id ON tunnel_device(pairing_id) WHERE pairing_id IS NOT NULL\");\n    this.db.exec(\"UPDATE tunnel_meta SET value = 2 WHERE key = 'schema'\");`,
    `    if (!columns.has(\"pairing_state\")) this.db.exec(\"ALTER TABLE tunnel_device ADD COLUMN pairing_state TEXT NOT NULL DEFAULT 'active'\");\n    if (!columns.has(\"user_id\")) this.db.exec(\"ALTER TABLE tunnel_device ADD COLUMN user_id TEXT NOT NULL DEFAULT 'usr_owner'\");\n    this.db.exec(\"CREATE UNIQUE INDEX IF NOT EXISTS tunnel_device_pairing_id ON tunnel_device(pairing_id) WHERE pairing_id IS NOT NULL\");\n    this.db.exec(\"CREATE INDEX IF NOT EXISTS tunnel_device_user ON tunnel_device(user_id, updated_at)\");\n    this.db.exec(\"CREATE TABLE IF NOT EXISTS tunnel_pairing_owner (pairing_id TEXT PRIMARY KEY, user_id TEXT NOT NULL)\");\n    this.db.exec(\"UPDATE tunnel_meta SET value = 3 WHERE key = 'schema'\");`,
    "tunnel account migration",
  );
  p.once(
    `  close(): void {\n    this.db.close();\n  }`,
    `  bindPairingOwner(pairingId: string, userId: string): void {\n    if (!pairingId || !userId) throw new Error(\"pairing and account are required\");\n    this.db.prepare(\"INSERT INTO tunnel_pairing_owner(pairing_id, user_id) VALUES (?, ?) ON CONFLICT(pairing_id) DO UPDATE SET user_id = excluded.user_id\").run(pairingId, userId);\n  }\n\n  pairingOwner(pairingId: string): string | undefined {\n    const row = this.db.prepare(\"SELECT user_id FROM tunnel_pairing_owner WHERE pairing_id = ?\").get(pairingId) as { user_id?: string } | undefined;\n    return row?.user_id;\n  }\n\n  close(): void {\n    this.db.close();\n  }`,
    "pairing owner methods",
  );
  p.once(
    `    const now = Date.now();\n    const existing = this.db.prepare(\"SELECT * FROM tunnel_device WHERE endpoint_id = ?\").get(input.endpointId) as\n      | { id: string; revoked_at: number | null; grant_revision: number; created_at: number; pairing_state: string; pairing_id: string | null } | undefined;`,
    `    const now = Date.now();\n    const userId = this.pairingOwner(input.pairingId) ?? OWNER_USER_ID;\n    const existing = this.db.prepare(\"SELECT * FROM tunnel_device WHERE endpoint_id = ?\").get(input.endpointId) as\n      | { id: string; user_id: string | null; revoked_at: number | null; grant_revision: number; created_at: number; pairing_state: string; pairing_id: string | null } | undefined;\n    if (existing?.user_id && existing.user_id !== userId) throw new Error(\"device belongs to another account\");`,
    "prepare device owner",
  );
  p.once(
    `import { randomBytes } from \"node:crypto\";`,
    `import { randomBytes } from \"node:crypto\";\n\nconst OWNER_USER_ID = ${JSON.stringify(OWNER)};`,
    "tunnel owner constant",
  );
  p.once(
    `        INSERT INTO tunnel_device(id, endpoint_id, label, platform, model, app_version, created_at, updated_at, last_seen_at, revoked_at, grant_revision, paired_via, last_transport, pairing_id, pairing_state)\n        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, 'pending')\n        ON CONFLICT(id) DO UPDATE SET\n          label=excluded.label,`,
    `        INSERT INTO tunnel_device(id, user_id, endpoint_id, label, platform, model, app_version, created_at, updated_at, last_seen_at, revoked_at, grant_revision, paired_via, last_transport, pairing_id, pairing_state)\n        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, 'pending')\n        ON CONFLICT(id) DO UPDATE SET\n          user_id=excluded.user_id,\n          label=excluded.label,`,
    "device insert owner",
  );
  p.once(
    `        id,\n        input.endpointId,`,
    `        id,\n        userId,\n        input.endpointId,`,
    "device insert owner arg",
  );
  p.once(
    `      id,\n      endpointId: String(row.endpoint_id),`,
    `      id,\n      userId: typeof row.user_id === \"string\" && row.user_id ? row.user_id : OWNER_USER_ID,\n      endpointId: String(row.endpoint_id),`,
    "hydrate device owner",
  );
  p.done();
}

{
  const p = file("packages/tunnel/src/serverEntry.ts");
  p.once(
    `      const result = await host.request(\"pairing.create\", {\n        profile,\n        mode: \"direct-preferred\",\n        label: typeof body.label === \"string\" ? body.label : \"\",\n        grants,\n      });\n      deps.events.emit(\"tunnel/pairing-created\", { id: (result.pairing as { id?: string })?.id ?? \"\" });`,
    `      const result = await host.request(\"pairing.create\", {\n        profile,\n        mode: \"direct-preferred\",\n        label: typeof body.label === \"string\" ? body.label : \"\",\n        grants,\n      });\n      const pairingId = (result.pairing as { id?: string })?.id ?? \"\";\n      if (pairingId) deps.store.bindPairingOwner(pairingId, request.space.userId);\n      deps.events.emit(\"tunnel/pairing-created\", { id: pairingId });`,
    "bind pairing to account",
  );
  p.once(
    `      json(200, deps.store.list().map((device) => dto(device)));`,
    `      json(200, deps.store.list().filter((device) => device.userId === request.space.userId).map((device) => dto(device)));`,
    "filter devices by account",
  );
  p.once(
    `    return {\n      ...live,\n      grants: device.grants,`,
    `    return {\n      ...live,\n      userId: device.userId,\n      grants: device.grants,`,
    "resolve paired account",
  );
  p.once(
    `              kind: \"paired-device\",\n              deviceId: device.id,`,
    `              kind: \"paired-device\",\n              userId: device.userId,\n              deviceId: device.id,`,
    "live paired account",
  );
  p.done();
}

console.log("multi-user account boundary patch applied");
