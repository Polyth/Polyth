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
        module: "/packages/sample/entry.js",
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

  assert.deepEqual(imported, ["/packages/sample/entry.js"]);
  assert.deepEqual(factoryHosts, [host]);
  const uninstall = installers.get("sample")?.();
  assert.equal(installs, 1);
  uninstall?.();
  assert.equal(uninstalls, 1);
});

test("one broken package bundle never blocks the remaining packages", async () => {
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const installers = await loadWebPackageInstallers(host, {
      fetch: (async () => new Response(JSON.stringify({
        packages: [
          { id: "broken", module: "/packages/broken/entry.js", styles: [] },
          { id: "healthy", module: "/packages/healthy/entry.js", styles: [] },
        ],
      }))) as typeof fetch,
      importModule: async (url) => {
        if (url.includes("broken")) throw new Error("404 not found");
        return { default: () => () => () => {} };
      },
    });
    assert.equal(installers.has("broken"), false);
    assert.equal(installers.has("healthy"), true);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]![0]), /web package "broken" failed to load/);
  } finally {
    console.error = originalError;
  }
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
