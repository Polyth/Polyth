import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { WebPackageHost } from "@polyth/web-sdk";

// Terraform's surface/capability lifecycle is the Terraform-owned half of the
// terminal project-tool contract.
register("./tsxHooks.mjs", import.meta.url);
const { default: terraformEntry } = await import("../widgets/index.tsx");

function host() {
  const opened: string[] = [];
  return { opened, value: {
    ui: { icons: {}, components: {} },
    navigation: { openWorkspacePane: (id: string) => { opened.push(id); } },
    errors: { friendly: (label: string) => `${label} failed.` },
  } as unknown as WebPackageHost };
}

test("Terraform entry removes all registrations on disable and can re-enable", () => {
  const registered = new Set<string>();
  const h = host();
  const registration = (kind: string) => (definition: { id: string }) => {
    const id = `${kind}:${definition.id}`;
    assert.equal(registered.has(id), false);
    registered.add(id);
    return () => { registered.delete(id); };
  };
  h.value.surfaces = { register: registration("surface") };
  h.value.capabilities = { register: registration("capability"), notify: () => {} };
  const install = terraformEntry(h.value);
  const dispose = install();
  assert.equal(registered.size, 2);
  dispose();
  assert.equal(registered.size, 0);
  install()();
  assert.equal(registered.size, 0);
});
