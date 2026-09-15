import assert from "node:assert/strict";
import { test } from "node:test";
import { createV2ProviderClient } from "../src/providerV2.ts";

const fixture = () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const integrations = [{ id: "account", name: "Account", methods: [
    { type: "env", names: ["TEST_API_KEY"] },
    { type: "oauth", id: "browser", label: "Browser", form: [{ key: "region", title: "Region", type: "string" }] },
    { type: "key", label: "API key" },
  ], connections: [{ type: "credential", id: "cred_one", label: "One" }] }];
  let status = "complete";
  let response: unknown;
  let providers: unknown[] = [{ id: "custom", name: "Custom", integrationID: "account" }];
  const client = createV2ProviderClient({
    locate: (path) => `${path}?location%5Bdirectory%5D=%2Fproject`,
    transport: {
      async queryRequired(path) {
        if (path.startsWith("/api/provider?")) return { data: providers };
        if (path.startsWith("/api/integration?")) return { data: integrations };
        if (path.includes("/connect/oauth/con_one?")) return { data: { status, time: { created: 1, expires: Date.now() + 10_000 } } };
        throw Error(`Unexpected query ${path}`);
      },
      async mutate(method, path, body) {
        calls.push({ method, path, body });
        if (response !== undefined) return response;
        return { kind: "response", status: path.includes("/connect/oauth?") ? 200 : 204, body: path.includes("/connect/oauth?")
          ? { data: { attemptID: "con_one", url: "https://provider.example/auth", instructions: "Enter code", mode: "code", time: { created: 1, expires: Date.now() + 10_000 } } }
          : undefined };
      },
    },
  });
  return { client, calls, integrations, setStatus(value: string) { status = value; }, setResponse(value: unknown) { response = value; }, setProviders(value: unknown[]) { providers = value; } };
};

test("V2 disconnected integrations remain visible and connectable before providers are available", async () => {
  const { client, setProviders, calls } = fixture();
  setProviders([]);
  assert.deepEqual(await client.listAllProviders(), [{ id: "account", name: "Account", env: ["TEST_API_KEY"] }]);
  assert.equal((await client.providerAuthMethods()).account?.[0]?.type, "oauth");
  assert.equal(await client.setProviderApiKey("account", "dummy-key"), true);
  assert.match(calls[0]!.path, /^\/api\/integration\/account\/connect\/key\?/);
});

test("V2 maps provider IDs to integration auth and credential logout", async () => {
  const { client, calls } = fixture();
  assert.deepEqual(await client.listAllProviders(), [{ id: "custom", name: "Custom", env: ["TEST_API_KEY"] }]);
  const methods = await client.providerAuthMethods();
  assert.equal(methods.custom?.[0]?.type, "oauth");
  assert.equal(methods.custom?.[0]?.prompts?.[0]?.key, "region");
  const index = methods.custom![0]!.upstreamIndex;
  assert.deepEqual(await client.providerAuthorize("custom", index, { region: "us" }), { url: "https://provider.example/auth", method: "code", instructions: "Enter code" });
  assert.equal(await client.providerAuthCallback("custom", index, "test-code"), true);
  await assert.rejects(client.providerAuthCallback("custom", index, "test-code"), /no longer available/);
  assert.equal(await client.setProviderApiKey("custom", "test-key", { region: "us" }), true);
  assert.equal(await client.removeProviderAuth("custom"), true);
  assert.deepEqual(calls.map(({ method, path, body }) => ({ method, path: path.split("?")[0], body })), [
    { method: "POST", path: "/api/integration/account/connect/oauth", body: { methodID: "browser", answer: { region: "us" } } },
    { method: "POST", path: "/api/integration/account/connect/oauth/con_one/complete", body: { code: "test-code" } },
    { method: "POST", path: "/api/integration/account/connect/key", body: { key: "test-key", answer: { region: "us" } } },
    { method: "DELETE", path: "/api/credential/cred_one", body: undefined },
  ]);
  assert.ok(calls.every((call) => call.path.endsWith("?location%5Bdirectory%5D=%2Fproject")));
});

test("V2 auth never treats unknown or rejected writes as success and redacts backend messages", async () => {
  for (const response of [{ kind: "unknown", message: "private-token", operationId: "x" }, { kind: "response", status: 401, body: { message: "private-token" } }, { kind: "response", status: 500, body: { message: "private-token" } }]) {
    const fixture_ = fixture();
    fixture_.setResponse(response);
    await assert.rejects(fixture_.client.setProviderApiKey("custom", "private-token"), (error: Error) => !error.message.includes("private-token"));
    assert.equal(fixture_.calls.length, 1);
  }
});

test("V2 OAuth method changes cannot reuse a previously displayed method index", async () => {
  const { client, integrations, calls } = fixture();
  const before = await client.providerAuthMethods();
  integrations[0]!.methods[1]!.id = "different-browser";
  await assert.rejects(client.providerAuthorize("custom", before.custom![0]!.upstreamIndex), /method changed/);
  assert.equal(calls.length, 0);
  const after = await client.providerAuthMethods();
  assert.notEqual(before.custom![0]!.upstreamIndex, after.custom![0]!.upstreamIndex);
});

test("V2 OAuth failure and malformed status do not establish connection", async () => {
  for (const status of ["failed", "expired", "unexpected"]) {
    const { client, setStatus } = fixture();
    const methods = await client.providerAuthMethods();
    await client.providerAuthorize("custom", methods.custom![0]!.upstreamIndex);
    setStatus(status);
    await assert.rejects(client.providerAuthCallback("custom", methods.custom![0]!.upstreamIndex, "code"));
  }
});

test("V2 malformed integration inventory fails explicitly", async () => {
  const { client, integrations } = fixture();
  integrations[0]!.connections.push({ type: "credential", id: "", label: "bad" });
  await assert.rejects(client.listAllProviders(), /invalid connection/);
});
