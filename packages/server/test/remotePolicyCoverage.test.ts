import { createHarnessRegistry } from "@polyth/harness-runtime";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRANT_PROFILE_PRESETS,
  PRIVILEGED_REMOTE_CAPABILITIES,
  isRemotePathPattern,
  matchRemotePath,
  type RemoteAccessPolicy,
} from "@polyth/contracts";
import {
  createServerServiceRegistry,
  serverServiceKey,
  discoverServerPackages,
  loadServerPackage,
  PairedSocketRegistry,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createRouteRegistry } from "../src/routeRegistry.ts";
import {
  CORE_LOCAL_ONLY_PREFIXES,
  CORE_REMOTE_ACCESS,
  allRemotePolicies,
  findRemoteHttpRule,
  findRemotePolicyOverlaps,
  isHttpMethod,
  validateRemoteAccessPolicy,
  type OwnedRemotePolicy,
} from "../src/remotePolicy.ts";

const packagesDir = join(import.meta.dirname, "../..");

function instantiate(pattern: string): string {
  return pattern.replace(/:[A-Za-z][A-Za-z0-9_]*/g, "x");
}

function stubHost(storageDir: string): ServerPackageHost {
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harnesses"), createHarnessRegistry());
  services.provide(serverServiceKey("opencode.runtime"), async () => ({}));
  services.provide(serverServiceKey("opencode.runtime.events"), {
    onRestart: () => ({ dispose() {} }),
  });
  const fallback = {
    get: () => ({
      stt: { baseUrl: "", model: "", apiKeyEnv: "", language: "" },
      tts: { baseUrl: "", model: "", apiKeyEnv: "", voice: "" },
    }),
    put: (value: unknown) => value,
    resolveKey: () => undefined,
  };
  return {
    pluginId: "inventory",
    storageDir,
    routes: { add: () => ({ dispose() {} }) },
    root: { provide() { return { dispose() {} }; } } as ServerPackageHost["root"],
    projects: { list: async () => [], get: async () => undefined, add: async () => { throw new Error("unused"); }, create: async () => { throw new Error("unused"); }, remove: async () => {} },
    sessions: {} as ServerPackageHost["sessions"],
    store: {
      profileList: async () => [],
      profileGet: async () => undefined,
      profileCreate: async () => { throw new Error("unused"); },
      profileUpdate: async () => { throw new Error("unused"); },
      profileRemove: async () => false,
    } as unknown as ServerPackageHost["store"],
    broadcast: { event() {}, projection() {} },
    runtimes: { forProject: async () => ({}) as never },
    services: {
      provide: (key, service) => services.provide(key, service),
      get: (key) => {
        if (key.id === serverServiceKey("opencode.runtime.events").id) {
          return { onRestart: () => ({ dispose() {} }) };
        }
        return services.get(key);
      },
      require: (key) => {
        if (key.id === serverServiceKey("opencode.runtime.events").id) {
          return { onRestart: () => ({ dispose() {} }) } as never;
        }
        const found = services.get(key);
        if (found !== undefined) return found as never;
        if (key.id === serverServiceKey("voice.settings").id) return fallback as never;
        return services.require(key);
      },
      ids: () => services.ids(),
    },
    forSpace: () => ({
      projects: { list: async () => [], get: async () => undefined, add: async () => { throw new Error("unused"); }, create: async () => { throw new Error("unused"); }, remove: async () => {} },
      sessions: { events: async () => [], snapshot: async () => { throw new Error("unused"); } } as never,
    }),
    spaceStorage: () => ({ root: storageDir, packageDir: () => storageDir, path: (rel: string) => join(storageDir, rel) }),
    deployment: "local",
    events: { append: async () => ({}) as never },
    oneShot: async () => "",
    smallModelComplete: async () => ({}) as never,
    smallModelInputBudget: async () => 0,
    smallModel: () => undefined,
    resolveSessionRuntime: async () => ({}) as never,
    loadPlugin: async () => ({ dispose() {} }),
    onHttpServer() {},
    attachHttpChannels() {},
    startTunnelIngress: async () => ({ close: async () => {} }),
    remotePolicies: () => [],
    attachPairedDeviceResolver() {},
    closePairedDevice() {},
    pairedSockets: new PairedSocketRegistry(),
  };
}

let packagePoliciesCache: Promise<OwnedRemotePolicy[]> | undefined;

async function loadPackagePolicies(): Promise<OwnedRemotePolicy[]> {
  packagePoliciesCache ??= (async () => {
    process.env.POLYTH_FAKE_BROWSER = "1";
    const discovered = await discoverServerPackages(packagesDir);
    const storageDir = mkdtempSync(join(tmpdir(), "polyth-policy-inventory-"));
    const policies: OwnedRemotePolicy[] = [];
    for (const pkg of discovered) {
      const host = stubHost(storageDir);
      host.pluginId = pkg.id;
      const loaded = await loadServerPackage(pkg, host);
      assert.ok(loaded.remoteAccess, `${pkg.id} must declare remoteAccess so paired-device default-deny is explicit`);
      policies.push({ owner: pkg.id, policy: loaded.remoteAccess });
    }
    return policies;
  })();
  return packagePoliciesCache;
}

test("every enabled package policy validates, local-only packages expose no remote routes, and every polyth-link route has one owner", async () => {
  validateRemoteAccessPolicy("core", CORE_REMOTE_ACCESS);
  const packagePolicies = await loadPackagePolicies();
  assert.ok(packagePolicies.length >= 25);

  const enabled: OwnedRemotePolicy[] = [{ owner: "core", policy: CORE_REMOTE_ACCESS }];
  for (const owned of packagePolicies) {
    validateRemoteAccessPolicy(owned.owner, owned.policy, enabled);
    enabled.push(owned);
  }
  assert.deepEqual(findRemotePolicyOverlaps(enabled), []);
  assert.deepEqual(findRemotePolicyOverlaps([...enabled].reverse()), []);

  for (const owned of packagePolicies) {
    if (owned.policy.http.length === 0) {
      assert.equal((owned.policy.websocket ?? []).length, 0, `${owned.owner} local-only policy must not expose websocket routes`);
    }
  }

  const all = allRemotePolicies(packagePolicies);
  for (const owned of all) {
    for (const rule of owned.policy.http) {
      assert.equal(isRemotePathPattern(rule.path), true, rule.path);
      const path = instantiate(rule.path);
      for (const method of rule.methods) {
        assert.equal(isHttpMethod(method), true);
        const match = findRemoteHttpRule(all, method, path);
        assert.ok(match, `${owned.owner} ${method} ${path} must match`);
        assert.equal(match.owner, owned.owner, `${method} ${path} owner`);
      }
    }
  }

  const remotePaths = CORE_REMOTE_ACCESS.http.map((rule) => rule.path);
  assert.ok(CORE_LOCAL_ONLY_PREFIXES.includes("/api/auth/login"));
  assert.ok(CORE_LOCAL_ONLY_PREFIXES.includes("/internal"));
  assert.ok(CORE_LOCAL_ONLY_PREFIXES.includes("/api/providers/custom"));
  assert.equal(remotePaths.includes("/api/auth/login"), false);
  assert.equal(remotePaths.includes("/api/providers/custom"), false);
  assert.equal(remotePaths.some((path) => path.startsWith("/api/sessions/") && path.includes("secrets")), false);
});

test("disabled package policy is not active in the route registry", () => {
  const registry = createRouteRegistry();
  const policy: RemoteAccessPolicy = {
    routeScopes: ["gadget"],
    http: [{
      methods: ["GET"],
      path: "/api/gadget/status",
      capability: "core.health.read",
      mutation: false,
    }],
  };
  const registration = registry.add("gadget", async () => true, policy);
  assert.equal(registry.policies().some((owned) => owned.owner === "gadget"), true);
  assert.ok(findRemoteHttpRule(
    [{ owner: "core", policy: CORE_REMOTE_ACCESS }, ...registry.policies()],
    "GET",
    "/api/gadget/status",
  ));
  registration.dispose();
  assert.equal(registry.policies().some((owned) => owned.owner === "gadget"), false);
  assert.equal(findRemoteHttpRule(
    [{ owner: "core", policy: CORE_REMOTE_ACCESS }, ...registry.policies()],
    "GET",
    "/api/gadget/status",
  ), null);
});

test("full-remote preset never includes privileged administration capabilities", () => {
  const full = new Set(GRANT_PROFILE_PRESETS["full-remote"]);
  for (const cap of PRIVILEGED_REMOTE_CAPABILITIES) {
    assert.equal(full.has(cap), false, cap);
  }
  assert.ok(GRANT_PROFILE_PRESETS.interact.includes("core.sessions.message"));
  assert.equal(GRANT_PROFILE_PRESETS.observe.includes("core.sessions.message"), false);
  assert.equal(GRANT_PROFILE_PRESETS.interact.includes("files.write"), false);
});

test("matchRemotePath still binds declared developer package routes", async () => {
  const packagePolicies = await loadPackagePolicies();
  const files = packagePolicies.find((owned) => owned.owner === "files");
  assert.ok(files);
  assert.equal(matchRemotePath("/api/files/write", "/api/files/write"), true);
  assert.equal(files.policy.http.some((rule) => rule.path === "/api/files/write"), true);
});
