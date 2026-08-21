import { test } from "node:test";
import assert from "node:assert/strict";

import { CAP, cap, type UiSlot, type UiSlotItem } from "@polyth/contracts";
import {
  assertDisposedClean,
  createContext,
  loadPlugin,
  resolveProfile,
  type KernelContext,
} from "@polyth/kernel";

const K = cap<string>("test.key");

test("provide/inject: priority wins, ties → last registered", () => {
  const ctx = createContext("p");
  ctx.provide(K, "low", 1);
  ctx.provide(K, "high", 10);
  assert.equal(ctx.inject(K), "high");

  ctx.provide(K, "tie-a", 5);
  ctx.provide(K, "tie-b", 5);
  assert.equal(ctx.inject(K), "high"); // priority 10 still wins over ties

  // a new context isolates the tie test cleanly
  const t = createContext("tie");
  t.provide(K, "tie-a", 5);
  t.provide(K, "tie-b", 5);
  assert.equal(t.inject(K), "tie-b"); // last registered wins on tie

  // disposable removes only the exact registration
  const d = t.provide(K, "temp", 100);
  assert.equal(t.inject(K), "temp");
  d.dispose();
  assert.equal(t.inject(K), "tie-b");
});

test("inject throws structured error when absent; optional returns undefined", () => {
  const ctx = createContext("p");
  assert.equal(ctx.optional(K), undefined);
  assert.throws(() => ctx.inject(K), /capability not provided: test\.key/);
});

test("parent inheritance: child sees parent provider; child shadow overrides", () => {
  const parent = createContext("p");
  parent.provide(K, "from-parent");
  const child = parent.scope("c") as KernelContext;

  assert.equal(child.inject(K), "from-parent");
  child.provide(K, "from-child");
  assert.equal(child.inject(K), "from-child");
  assert.equal(parent.inject(K), "from-parent"); // parent unaffected
});

test("waterfall: serial async reduce in registration order", async () => {
  const ctx = createContext("w");
  const order: number[] = [];
  ctx.on("w", async (v: never) => {
    order.push(1);
    return (v as unknown as number) + 1;
  });
  ctx.on("w", async (v: never) => {
    order.push(2);
    await new Promise((r) => setTimeout(r, 5));
    return (v as unknown as number) * 10;
  });
  ctx.on("w", async (v: never) => {
    order.push(3);
    return undefined; // keep current value
  });

  const result = await ctx.waterfall<number>("w", 1);
  assert.equal(result, 20); // (1+1)*10
  assert.deepEqual(order, [1, 2, 3]);
});

test("effect disposal is LIFO (reverse order)", async () => {
  const ctx = createContext("e");
  const log: string[] = [];
  ctx.effect(() => {
    log.push("a");
  });
  ctx.effect(() => {
    log.push("b");
  });
  await ctx.dispose();
  assert.deepEqual(log, ["b", "a"]); // reverse of registration
});

test("loadPlugin: missing required capability throws listing missing ids", async () => {
  const ctx = createContext("lp");
  const err = await loadPlugin(
    ctx,
    {
      manifest: {
        id: "p.missing",
        version: "1.0.0",
        trust: "pure",
        requires: ["polyth.sessions", "polyth.projects"],
      },
      setup() {},
    },
    {},
  ).then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.ok(err instanceof Error);
  assert.match(err.message, /missing required capabilities/);
  assert.match(err.message, /polyth\.sessions/);
  assert.match(err.message, /polyth\.projects/);
});

test("loadPlugin: setup runs in child scope; dispose cleans child only", async () => {
  const parent = createContext("lp2");
  parent.provide(cap<string>("shared"), "shared-value");

  let disposed = false;
  const disposable = await loadPlugin(
    parent,
    {
      manifest: { id: "p.ok", version: "1.0.0", trust: "pure", provides: ["p.ok.svc"] },
      setup(ctx) {
        ctx.provide(cap<string>("p.ok.svc"), "hello");
        ctx.effect(() => {
          disposed = true;
        });
      },
    },
    { flag: true },
  );

  // capability is visible on the parent (child scope inheritance is upward via lookup? no —
  // providers live in the child; parent should NOT see it). Assert child isolation:
  assert.equal(parent.optional(cap<string>("p.ok.svc")), undefined);

  await disposable.dispose();
  assert.equal(disposed, true);
  // parent still alive
  assert.equal(parent.inject(cap<string>("shared")), "shared-value");
});

test("loadPlugin registers every manifest widget through the scoped UI registry", async () => {
  const parent = createContext("widget-plugin");
  const items = new Map<string, UiSlotItem>();
  parent.provide(CAP.ui, {
    addSlot(item: UiSlotItem) {
      items.set(item.id, item);
      return { dispose: () => { items.delete(item.id); } };
    },
    list(slot: UiSlot) {
      return [...items.values()].filter((item) => item.slot === slot);
    },
  });
  const disposable = await loadPlugin(parent, {
    manifest: {
      id: "sample",
      version: "1.0.0",
      trust: "ui-only",
      widgets: [
        {
          id: "sample.canvas",
          module: "sample-canvas",
          title: "Canvas",
          description: "Canvas widget",
          kind: "widget",
          defaultSlot: "workspace.main",
          supportedSlots: ["workspace.main"],
        },
        {
          id: "sample.action",
          module: "sample-action",
          title: "Action",
          description: "Toolbar action",
          kind: "mini-widget",
          defaultSlot: "session.header.actions",
          supportedSlots: ["session.header.actions", "app.header.actions"],
        },
      ],
    },
    setup() {},
  });

  assert.deepEqual([...items.keys()], ["sample.canvas", "sample.action"]);
  assert.equal(items.get("sample.action")?.slot, "widget.catalog");
  assert.equal(items.get("sample.action")?.props?.pluginId, "sample");
  await disposable.dispose();
  assert.deepEqual([...items.keys()], []);
});

test("dispose-then-use throws", async () => {
  const ctx = createContext("d");
  await ctx.dispose();
  assert.throws(() => ctx.provide(K, "x"), /disposed/);
  assert.throws(() => ctx.inject(K), /disposed/);
  assert.throws(() => ctx.on("e", () => {}), /disposed/);
  assert.throws(() => ctx.emit("e", {}), /disposed/);
  assert.throws(() => ctx.effect(() => {}), /disposed/);
});

test("assertDisposedClean: empty residual after dispose", async () => {
  const ctx = createContext("clean");
  ctx.provide(K, "v");
  ctx.on("e", () => {});
  ctx.effect(() => {});
  const residual = await assertDisposedClean(ctx);
  assert.deepEqual(residual, { providers: [], listeners: [], contributions: 0 });
});

test("resolveProfile: bundle order then explicit plugins, deduped", () => {
  const r = resolveProfile({
    bundles: {
      b1: ["core", "sessions"],
      b2: ["ui", "sessions"], // duplicate of sessions across bundles
    },
    bundleOrder: ["b1", "b2"],
    plugins: ["extra", "core"], // core already present
    patches: [
      { id: "sessions/timeout", config: { ms: 100 } },
      { id: "ui/theme", config: { dark: true } },
    ],
  });
  assert.deepEqual(r.plugins, ["core", "sessions", "ui", "extra"]);
  assert.deepEqual(
    [...r.configs.entries()],
    [
      ["sessions", { ms: 100 }],
      ["ui", { dark: true }],
    ],
  );
});

test("resolveProfile: deterministic output, empty inputs", () => {
  const a = resolveProfile({ bundleOrder: [] });
  const b = resolveProfile({ bundleOrder: [] });
  assert.deepEqual(a, b);
  assert.deepEqual(a.plugins, []);
  assert.equal(a.configs.size, 0);
});
