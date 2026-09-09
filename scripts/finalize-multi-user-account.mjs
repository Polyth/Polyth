import { readFileSync, writeFileSync } from "node:fs";

function edit(path, mutate) {
  const before = readFileSync(path, "utf8");
  const after = mutate(before);
  if (after === before) throw new Error(`${path}: patch made no changes`);
  writeFileSync(path, after);
}

function once(text, from, to, label) {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`missing ${label}`);
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`ambiguous ${label}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

function all(text, from, to, expected, label) {
  const count = text.split(from).length - 1;
  if (count !== expected) throw new Error(`expected ${expected} ${label}, got ${count}`);
  return text.split(from).join(to);
}

// Auth status identifies only the authenticated account. It never enumerates
// server accounts on the public status endpoint.
edit("packages/contracts/src/index.ts", (text) => once(
  text,
  `export interface AuthStatusDto {\n  required: boolean;\n  authorized: boolean;\n  scope: AuthScope;\n}`,
  `export interface AuthStatusDto {\n  required: boolean;\n  authorized: boolean;\n  scope: AuthScope;\n  /** Current authenticated account. Omitted for anonymous callers. */\n  accountId?: string;\n}`,
  "AuthStatusDto account id",
));

edit("packages/server/src/auth.ts", (text) => once(
  text,
  `    statusDto(resolution) {\n      return {\n        required: resolution.principal.kind === "paired-device" ? false : svc.enabled(),\n        authorized: resolution.authenticated,\n        scope: resolution.principal.kind,\n      };\n    },`,
  `    statusDto(resolution) {\n      const accountId = svc.userIdForPrincipal(resolution.principal);\n      return {\n        required: resolution.principal.kind === "paired-device" ? false : svc.enabled(),\n        authorized: resolution.authenticated,\n        scope: resolution.principal.kind,\n        ...(accountId ? { accountId } : {}),\n      };\n    },`,
  "auth status account id",
));

edit("packages/server/src/routes/auth.ts", (source) => {
  let text = source;
  text = once(
    text,
    `export function authRoutes(auth: AuthService): RouteHandler {`,
    `export interface AuthRoutesDeps {\n  /** Revoke non-cookie access (paired devices/pending pairings) before account removal. */\n  revokeAccountAccess?(userId: string): void | Promise<void>;\n}\n\nexport function authRoutes(auth: AuthService, deps: AuthRoutesDeps = {}): RouteHandler {`,
    "auth route dependencies",
  );
  text = once(
    text,
    `      rc.json(200, { ...auth.statusDto(resolution), accounts: accountList(auth) });`,
    `      rc.json(200, auth.statusDto(resolution));`,
    "public account enumeration",
  );
  text = once(
    text,
    `      if (currentUserId !== OWNER_USER_ID) {\n        rc.json(403, { error: "forbidden", message: "server account management requires the owner account" });\n        return true;\n      }\n      const body = await rc.body();`,
    `      if (currentUserId !== OWNER_USER_ID) {\n        rc.json(403, { error: "forbidden", message: "server account management requires the owner account" });\n        return true;\n      }\n      // Creating the first secondary credential turns the server auth gate on.\n      // Require the owner to be login-capable first or the owner could lock\n      // themselves out immediately after this request returns.\n      if (!auth.hasCredential(OWNER_USER_ID)) {\n        rc.json(409, { error: "conflict", message: "set the owner password before adding another account" });\n        return true;\n      }\n      const body = await rc.body();`,
    "owner lockout guard",
  );
  text = once(
    text,
    `      if (!auth.hasCredential(target) || !auth.removeAccount(target)) {\n        rc.json(404, { error: "not-found", message: "account not found" });\n        return true;\n      }\n      rc.json(200, { ok: true });`,
    `      if (!auth.hasCredential(target)) {\n        rc.json(404, { error: "not-found", message: "account not found" });\n        return true;\n      }\n      // Pairings are authentication too. Revoke them before credentials so a\n      // failed external-access cleanup never leaves a half-removed account.\n      await deps.revokeAccountAccess?.(target);\n      if (!auth.removeAccount(target)) {\n        rc.json(404, { error: "not-found", message: "account not found" });\n        return true;\n      }\n      rc.json(200, { ok: true });`,
    "account removal access revocation",
  );
  return text;
});

// A restored cookie must select the same browser-local account namespace before
// uiPrefs/composer preferences evaluate during bootstrap.
edit("apps/web/src/authPrefetch.ts", (source) => {
  let text = source;
  text = once(
    text,
    `import type { AuthStatusDto } from "@polyth/session/web-api";`,
    `import type { AuthStatusDto } from "@polyth/session/web-api";\nimport { setActiveBrowserAccount } from "./accountStorage.ts";`,
    "auth prefetch account storage import",
  );
  text = once(
    text,
    `export function prefetchAuthStatus(): void {\n  if (inflight) return;\n  inflight = fetch("/api/auth/status").then(async (res) => {\n    if (!res.ok) throw new Error(\`auth status: HTTP \${res.status}\`);\n    return await res.json() as AuthStatusDto;\n  });\n  // Consumed (and error-handled) by Root; an unconsumed failure must not\n  // surface as an unhandled rejection during boot.\n  inflight.catch(() => undefined);\n}`,
    `export function prefetchAuthStatus(): Promise<AuthStatusDto> {\n  if (inflight) return inflight;\n  inflight = fetch("/api/auth/status").then(async (res) => {\n    if (!res.ok) throw new Error(\`auth status: HTTP \${res.status}\`);\n    const status = await res.json() as AuthStatusDto;\n    if (status.authorized && status.accountId) setActiveBrowserAccount(status.accountId);\n    return status;\n  });\n  // Consumed (and error-handled) by Root; an unconsumed failure must not\n  // surface as an unhandled rejection during boot.\n  inflight.catch(() => undefined);\n  return inflight;\n}`,
    "auth prefetch account alignment",
  );
  return text;
});

edit("apps/web/src/main.tsx", (text) => once(
  text,
  `  prefetchAuthStatus();\n  await ensureLocale(getLocaleSnapshot());\n  await import("./bootstrap.tsx");`,
  `  const authStatus = prefetchAuthStatus();\n  await ensureLocale(getLocaleSnapshot());\n  // Keep auth and locale parallel, but do not evaluate account-scoped app\n  // modules until a remembered cookie has restored its browser namespace.\n  await authStatus.catch(() => undefined);\n  await import("./bootstrap.tsx");`,
  "bootstrap account alignment",
));

// AgentProfile remains the persisted compatibility type, but the user-facing
// concept is an account-owned Preset and never lives inside ModelPicker.
edit("apps/web/src/components/Composer.tsx", (source) => {
  let text = source;
  text = once(
    text,
    `  loadComposerConfig, saveComposerConfig, consumeComposerConfig, wireProfileId,\n`,
    `  loadComposerConfig, saveComposerConfig, consumeComposerConfig,\n`,
    "wire profile import",
  );
  text = once(
    text,
    `import { migrateFavoritesOnce, profilesLoaded, useProfiles } from "../profiles.ts";`,
    `import { profilesLoaded, useProfiles } from "../profiles.ts";`,
    "favorites profile migration import",
  );
  text = once(
    text,
    `  // One-time favorites → profiles migration once models are known.\n  useEffect(() => {\n    if (models.length > 0) void migrateFavoritesOnce(models);\n  }, [models]);\n\n`,
    ``,
    "favorites to profiles migration",
  );

  text = once(
    text,
    `    const cfgSent = cfg;\n    const wire = wireProfileId(cfgSent);\n    const selected = cfgSent.model ?? session?.model ?? preferredModel;\n    const selectedDescriptor = selected\n      ? chatModels.find((candidate) => modelIdentityMatches(candidate, selected))\n      : undefined;\n    const sentThinking = resolveComposerThinking({\n      ...(selectedDescriptor ? { descriptor: selectedDescriptor } : {}),\n      configThinking: cfgSent.thinking,\n      ...(getModelThinking(selected) ? { savedThinking: getModelThinking(selected)! } : {}),\n      ...(sessionDefaults.defaultThinking ? { sessionDefault: sessionDefaults.defaultThinking } : {}),\n    }).variant;\n    const sentModel = selected && selectedDescriptor\n      ? {\n          providerID: selected.providerID,\n          modelID: selected.modelID,\n          ...(sentThinking ? { variant: sentThinking } : {}),\n        }\n      : undefined;\n    const selectedNativeCommand = command === null && commandCatalog.state === "available"\n      ? nativeCommandInput(t, commandCatalog.items, selectedCommandRef.current)\n      : undefined;\n    const selectedProfileId = cfgSent.profile.kind === "id" ? cfgSent.profile.id : undefined;\n    const selectedProfile = selectedProfileId\n      ? profiles.find((profile) => profile.id === selectedProfileId)\n      : undefined;`,
    `    const cfgSent = cfg;\n    const selectedProfileId = cfgSent.profile.kind === "id" ? cfgSent.profile.id : undefined;\n    const selectedProfile = selectedProfileId\n      ? profiles.find((profile) => profile.id === selectedProfileId)\n      : undefined;\n    // Preset ids are private account state. Resolve the authenticated preset\n    // into the ordinary execution bundle before crossing into shared session\n    // services; only model/agent/thinking become session-visible.\n    const presetModel = selectedProfile ? {\n      providerID: selectedProfile.providerID,\n      modelID: selectedProfile.modelID,\n      ...(selectedProfile.harnessId ? { harnessId: selectedProfile.harnessId } : {}),\n    } : undefined;\n    const selected = cfgSent.model ?? presetModel ?? session?.model ?? preferredModel;\n    const selectedDescriptor = selected\n      ? chatModels.find((candidate) => modelIdentityMatches(candidate, selected))\n      : undefined;\n    const sentThinking = selectedProfile?.thinking ?? resolveComposerThinking({\n      ...(selectedDescriptor ? { descriptor: selectedDescriptor } : {}),\n      configThinking: cfgSent.thinking,\n      ...(getModelThinking(selected) ? { savedThinking: getModelThinking(selected)! } : {}),\n      ...(sessionDefaults.defaultThinking ? { sessionDefault: sessionDefaults.defaultThinking } : {}),\n    }).variant;\n    const sentModel = selected && selectedDescriptor\n      ? {\n          providerID: selected.providerID,\n          modelID: selected.modelID,\n          ...(sentThinking ? { variant: sentThinking } : {}),\n        }\n      : undefined;\n    const sentAgent = cfgSent.agent ?? selectedProfile?.agent;\n    const selectedNativeCommand = command === null && commandCatalog.state === "available"\n      ? nativeCommandInput(t, commandCatalog.items, selectedCommandRef.current)\n      : undefined;`,
    "preset execution resolution",
  );
  text = all(text, `            ...(cfgSent.agent ? { agent: cfgSent.agent } : {}),`, `            ...(sentAgent ? { agent: sentAgent } : {}),`, 2, "session creation preset agent");
  text = once(text, `          cfgSent.agent,`, `          sentAgent,`, "existing session preset agent");
  text = once(text, `            ...(wire !== undefined ? { agentProfileId: wire } : {}),\n`, ``, "private preset wire id");
  text = once(
    text,
    `  const profileControl = <Picker\n    className="composer-profile-chip"\n    label="Profile"\n    mobileSheet\n    direction="up"\n    items={profileItems}\n    value={profileValue}\n    searchable={compatibleProfiles.length > 8}\n    onPick={pickProfile}\n    placeholder={profileItems.find((item) => item.id === profileValue)?.label ?? "Profile"}\n    ariaLabel={\`Select profile, current: \${profileItems.find((item) => item.id === profileValue)?.label ?? "Default"}\`}\n  />;`,
    `  const profileControl = <Picker\n    className="composer-profile-chip"\n    label="Preset"\n    mobileSheet\n    direction="up"\n    items={profileItems}\n    value={profileValue}\n    searchable={compatibleProfiles.length > 8}\n    onPick={pickProfile}\n    placeholder={profileItems.find((item) => item.id === profileValue)?.label ?? "Preset"}\n    ariaLabel={\`Select preset, current: \${profileItems.find((item) => item.id === profileValue)?.label ?? "Default"}\`}\n  />;`,
    "preset control terminology",
  );
  text = once(text, `    executionProfileControl: profileControl,\n`, ``, "model picker preset injection");
  text = once(
    text,
    `        <span className="composer-execution">\n          {phoneLayout && modelControl}\n          <SlotHost slot="composer.execution" context={slotContext} />\n        </span>`,
    `        <span className="composer-execution">\n          {phoneLayout && profileControl}\n          {phoneLayout && modelControl}\n          <SlotHost slot="composer.execution" context={slotContext} />\n        </span>`,
    "phone preset placement",
  );
  text = once(
    text,
    `          <div className="composer-config">\n            {!phoneLayout && modelControl}\n          </div>`,
    `          <div className="composer-config">\n            {!phoneLayout && profileControl}\n            {!phoneLayout && modelControl}\n          </div>`,
    "desktop preset placement",
  );
  return text;
});

// Account deletion must revoke every authentication path, including pending
// Link pairings and already-paired devices.
edit("packages/tunnel/src/index.ts", (text) => once(
  text,
  `  releasePairingOwner(pairingId: string): void {\n    this.db.prepare("DELETE FROM tunnel_pairing_owner WHERE pairing_id = ?").run(pairingId);\n  }\n`,
  `  releasePairingOwner(pairingId: string): void {\n    this.db.prepare("DELETE FROM tunnel_pairing_owner WHERE pairing_id = ?").run(pairingId);\n  }\n\n  releasePairingsForUser(userId: string): string[] {\n    const rows = this.db.prepare("SELECT pairing_id FROM tunnel_pairing_owner WHERE user_id = ?").all(userId) as Array<{ pairing_id: string }>;\n    for (const row of rows) {\n      const device = this.deviceByPairing(row.pairing_id);\n      if (device && device.pairingState !== "active" && device.pairingState !== "failed") {\n        this.failPairing(row.pairing_id);\n      } else {\n        this.releasePairingOwner(row.pairing_id);\n      }\n    }\n    return rows.map((row) => row.pairing_id);\n  }\n`,
  "release account pairings",
));

edit("packages/tunnel/src/serverEntry.ts", (source) => {
  let text = source;
  text = once(
    text,
    `import {\n  type ServerPackage,\n  type ServerPackageHost,\n} from "@polyth/plugins";`,
    `import {\n  serverServiceKey,\n  type ServerPackage,\n  type ServerPackageHost,\n} from "@polyth/plugins";`,
    "tunnel service key import",
  );
  text = once(
    text,
    `  let device: ReturnType<TunnelStore["prepareDevice"]> | undefined;\n  let activated = false;\n  try {\n    device = deps.store.prepareDevice({\n      ...input,\n      pairedVia: "polyth-link",\n    });`,
    `  const existing = deps.store.deviceByPairing(input.pairingId);\n  const ownerUserId = deps.store.pairingOwner(input.pairingId)\n    ?? (existing?.pairingState === "active" && !existing.revokedAt ? existing.ownerUserId : undefined);\n  if (!ownerUserId) throw notFound("unknown pairing");\n  let device: ReturnType<TunnelStore["prepareDevice"]> | undefined;\n  let activated = false;\n  try {\n    device = deps.store.prepareDevice({\n      ...input,\n      ownerUserId,\n      pairedVia: "polyth-link",\n    });`,
    "pairing owner required at commit",
  );
  text = once(
    text,
    `    const owner = deps.store.pairingOwner(id) ?? deps.store.deviceByPairing(id)?.ownerUserId ?? OWNER_USER_ID;\n    if (owner !== userId) throw notFound("unknown pairing");`,
    `    const owner = deps.store.pairingOwner(id) ?? deps.store.deviceByPairing(id)?.ownerUserId;\n    if (!owner || owner !== userId) throw notFound("unknown pairing");`,
    "pairing ownership fallback",
  );
  text = once(
    text,
    `  const connections = new Map<string, AuthPrincipal>();\n  let linkHost: LinkHostClient | null = null;\n  let ingressHandle: { close(): Promise<void> } | null = null;`,
    `  const connections = new Map<string, AuthPrincipal>();\n  let linkHost: LinkHostClient | null = null;\n  host.services.provide(serverServiceKey<{ revokeAccount(userId: string): Promise<void> }>("tunnel.account-access"), {\n    async revokeAccount(userId) {\n      const pending = store.releasePairingsForUser(userId);\n      if (linkHost?.available) {\n        for (const pairingId of pending) {\n          try { await linkHost.request("pairing.cancel", { id: pairingId }); } catch { /* local claim is already invalid */ }\n        }\n      }\n      for (const device of store.list(userId)) {\n        if (!device.revokedAt) store.revoke(device.id);\n        for (const [connectionId, principal] of connections) {\n          if (principal.kind === "paired-device" && principal.deviceId === device.id) connections.delete(connectionId);\n        }\n        host.closePairedDevice(device.id);\n        if (linkHost?.available) {\n          try { await linkHost.request("trust.revoke", { deviceId: device.id, endpointId: device.endpointId }); } catch {\n            // Canonical auth already rejects the locally revoked row. Host trust\n            // cleanup is best-effort and is re-synchronised on restart.\n          }\n        }\n      }\n    },\n  });\n  let ingressHandle: { close(): Promise<void> } | null = null;`,
    "tunnel account access service",
  );
  return text;
});

edit("packages/server/src/index.ts", (text) => once(
  text,
  `    authRoutes(auth),`,
  `    authRoutes(auth, {\n      revokeAccountAccess: async (userId) => {\n        await svc<{ revokeAccount(userId: string): Promise<void> }>("tunnel.account-access")?.revokeAccount(userId);\n      },\n    }),`,
  "auth account access service wiring",
));

edit("packages/server/test/auth.test.ts", (text) => once(
  text,
  `  assert.deepEqual(status1.payload, { required: true, authorized: true, scope: "ui-session" });`,
  `  assert.deepEqual(status1.payload, { required: true, authorized: true, scope: "ui-session", accountId: "usr_owner" });`,
  "authenticated status account id expectation",
));

edit("packages/tunnel/test/pairingCommit.test.ts", (source) => {
  let text = source;
  text = once(
    text,
    `    const { host } = fakeHost(failedMethod);\n    await assert.rejects(commitPairingDevice(input(failedMethod[0]!), {\n      store,\n      host,\n      events: new TunnelEventBus(),\n    }));\n    const device = store.deviceByPairing(\`pair-\${failedMethod[0]}\`)!;`,
    `    const { host } = fakeHost(failedMethod);\n    const failedInput = input(failedMethod[0]!);\n    store.claimPairing(failedInput.pairingId, "usr_alice");\n    await assert.rejects(commitPairingDevice(failedInput, {\n      store,\n      host,\n      events: new TunnelEventBus(),\n    }));\n    const device = store.deviceByPairing(failedInput.pairingId)!;`,
    "failed pairing owner claim",
  );
  return text;
});

console.log("multi-user finalization patch applied");
