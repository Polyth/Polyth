import test from "node:test";
import { serverServiceKey } from "@polyth/plugins";
import registerPackage from "../src/serverEntry.ts";

// Packages enable in discovery order, so Personal Coach starts before Schedule,
// whose task store only exists once Schedule itself is enabled.
test("Coach enables and disables while the schedule service is not enabled yet", async () => {
  const services = new Map<string, unknown>();
  services.set(serverServiceKey("agents").id, new Proxy({}, {
    get() {
      throw Object.assign(new Error("planner is not enabled"), { code: "unavailable" });
    },
  }));
  const host = {
    services: {
      provide: (key: { id: string }, value: unknown) => { services.set(key.id, value); },
      get: (key: { id: string }) => services.get(key.id),
      require: (key: { id: string }) => services.get(key.id),
    },
    store: { projections: async () => [] },
    projects: { get: async () => undefined, list: async () => [] },
    spaceStorage: () => { throw new Error("no Coach workspace is opened in this test"); },
    events: { append: async () => ({ seq: 1 }) },
  };
  const pkg = registerPackage(host as unknown as Parameters<typeof registerPackage>[0]);
  await pkg.onEnable?.();
  await pkg.onDisable?.();
});
