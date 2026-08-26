import test from "node:test";
import assert from "node:assert/strict";
import type { WebPackageHost } from "@polyth/web-sdk";
import { loadWebPackageInstallers } from "../src/packages/webEntries.ts";

const host = {} as WebPackageHost;

test("runtime web-entry loading creates package lifecycle installers", async () => {
  const factoryHosts: WebPackageHost[] = [];
  const imported: string[] = [];
  let installs = 0;
  let uninstalls = 0;
  const installers = await loadWebPackageInstallers(host, {
    fetch: (async () => new Response(JSON.stringify({
      packages: [{
        id: "sample",
        module: "/web-packages/sample/entry.js",
        styles: [],
      }],
    }))) as typeof fetch,
    importModule: async (url) => {
      imported.push(url);
      return {
        default: (received: WebPackageHost) => {
          factoryHosts.push(received);
          return () => {
            installs++;
            return () => { uninstalls++; };
          };
        },
      };
    },
  });

  assert.deepEqual(imported, ["/web-packages/sample/entry.js"]);
  assert.deepEqual(factoryHosts, [host]);
  const uninstall = installers.get("sample")?.();
  assert.equal(installs, 1);
  uninstall?.();
  assert.equal(uninstalls, 1);
});

test("runtime loader rejects executable URLs outside the generated package root", async () => {
  await assert.rejects(
    () => loadWebPackageInstallers(host, {
      fetch: (async () => new Response(JSON.stringify({
        packages: [{ id: "bad", module: "https://evil.test/plugin.js", styles: [] }],
      }))) as typeof fetch,
    }),
    /manifest is invalid/,
  );
});
