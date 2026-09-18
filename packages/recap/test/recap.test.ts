import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionAssist, SessionEvent, SessionProjection } from "@polyth/contracts";
import {
  buildRecapPrompt,
  capWords,
  createRecapService,
  createRecapSettings,
  isFresh,
  parseRecapReply,
  RECAP_MAX_WORDS,
} from "../src/recap.ts";
import { recapRoutes } from "../src/serverEntry.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-recap-"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("recap settings keep legacy quiet time while package lifecycle owns enablement", () => {
  const file = join(tmp(), "assist.json");
  writeFileSync(file, JSON.stringify({ enabled: false, idleSeconds: 45 }));
  const settings = createRecapSettings({ file });
  assert.deepEqual(settings.get(), { idleSeconds: 45 });

  assert.deepEqual(settings.put({ enabled: true, idleSeconds: 3 }), { idleSeconds: 10 });
  assert.doesNotMatch(readFileSync(file, "utf8"), /"enabled"/);
  assert.equal(settings.put({ idleSeconds: 99_999 }).idleSeconds, 3600);
  assert.throws(() => settings.put({ idleSeconds: "soon" }), /number/);
});

test("recap settings leave corrupt legacy state untouched until a deliberate write", () => {
  const file = join(tmp(), "assist.json");
  writeFileSync(file, "{{{");
  const before = readFileSync(file, "utf8");
  const settings = createRecapSettings({ file });
  assert.deepEqual(settings.get(), { idleSeconds: 120 });
  assert.equal(readFileSync(file, "utf8"), before);
});

test("recap helpers cap text, parse optional suggestions, and check freshness", () => {
  assert.equal(capWords("one two three", 5), "one two three");
  assert.equal(capWords("a b c d", 2), "a b…");
  assert.equal(isFresh(undefined, 5), false);
  assert.equal(isFresh({ atSeq: 5 }, 5), true);
  assert.equal(isFresh({ atSeq: 5 }, 6), false);

  assert.deepEqual(
    parseRecapReply("Recap: fixed the queue.\nSuggestion: Add a regression test."),
    { recap: "fixed the queue.", suggestion: "Add a regression test." },
  );
  assert.deepEqual(parseRecapReply("Recap: shipped the fix.\nSuggestion: none"), {
    recap: "shipped the fix.",
  });
  assert.equal(parseRecapReply("one unlabeled line"), null);
  const long = parseRecapReply(`Recap: ${"word ".repeat(40)}\nSuggestion: do x`);
  assert.equal(long!.recap.split(/\s+/).length, RECAP_MAX_WORDS);
  assert.match(buildRecapPrompt("T"), /Suggestion: none/);
  assert.match(buildRecapPrompt("T"), /<conversation>\nT\n<\/conversation>/);
});

function serviceHarness(opts: {
  idleSeconds?: number;
  completeDelayMs?: number;
  reply?: string;
}) {
  let seq = 10;
  const events: SessionEvent[] = [];
  const saves: Array<{ sessionId: string; assist: SessionAssist }> = [];
  const completes: string[] = [];
  const errors: unknown[] = [];
  const bumpSeq = (type = "user/message", ignorable = false) => {
    seq += 1;
    events.push({
      id: `e${seq}`,
      sessionId: "s1",
      seq,
      time: Date.now(),
      type,
      data: {},
      v: 1,
      ...(ignorable ? { ignorable: true } : {}),
    } as SessionEvent);
  };
  const service = createRecapService({
    settings: () => ({ idleSeconds: opts.idleSeconds ?? 0.01 }),
    latestSeq: async () => seq,
    eventsAfter: async (_sessionId, afterSeq) => events.filter((event) => event.seq > afterSeq),
    transcript: async () => "User: fix the bug\n\nAssistant: fixed it",
    complete: async (_sessionId, prompt) => {
      completes.push(prompt);
      if (opts.completeDelayMs) await sleep(opts.completeDelayMs);
      return opts.reply ?? "Recap: fixed the bug\nSuggestion: Add a regression test.";
    },
    save: async (sessionId, assist) => { saves.push({ sessionId, assist }); },
    onError: (_sessionId, error) => { errors.push(error); },
  });
  return { service, saves, completes, errors, bumpSeq };
}

test("recap service saves quiet results and absorbs passive bookkeeping", async () => {
  const h = serviceHarness({ idleSeconds: 0.04 });
  h.service.onTurnCompleted("s1", "usr_test");
  await sleep(10);
  h.bumpSeq("usage/recorded", true);
  h.bumpSeq("session/metadata-changed", true);
  await sleep(100);
  assert.equal(h.completes.length, 1);
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0]!.assist.atSeq, 12);
  assert.equal(h.saves[0]!.assist.recap, "fixed the bug");
  assert.equal(h.errors.length, 0);
  h.service.stop();
});

test("recap service drops conversation-stale and disabled-in-flight work", async () => {
  const stale = serviceHarness({ idleSeconds: 0.02, completeDelayMs: 80 });
  stale.service.onTurnCompleted("s1");
  await sleep(40);
  stale.bumpSeq();
  await sleep(100);
  assert.equal(stale.completes.length, 1);
  assert.equal(stale.saves.length, 0);
  stale.service.stop();

  const disabled = serviceHarness({ idleSeconds: 0.02, completeDelayMs: 80 });
  disabled.service.onTurnCompleted("s1");
  await sleep(40);
  disabled.service.stop();
  await sleep(100);
  assert.equal(disabled.completes.length, 1);
  assert.equal(disabled.saves.length, 0);
});

const projection = (id: string, assist?: SessionAssist): SessionProjection => ({
  id,
  projectId: "p1",
  title: "t",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...(assist ? { assist } : {}),
});

function routeHarness(opts: {
  projections?: Record<string, SessionProjection>;
  latestSeq?: number;
}) {
  const settings = createRecapSettings({ file: join(tmp(), "assist.json") });
  const routes = recapRoutes({
    settings,
    projection: async (id) => opts.projections?.[id],
    latestConversationSeq: async () => opts.latestSeq ?? 0,
  });
  const call = async (method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const handled = await routes({
      req: {},
      res: {},
      space: { spaceId: "space-1", userId: "usr_test", membership: { role: "owner" } },
      url: new URL(`http://x${path}`),
      path,
      method,
      body: async () => body,
      json: (code: number, value: unknown) => { status = code; payload = value; },
    } as never);
    return { handled, status, payload };
  };
  return { call };
}

test("recap package owns quiet-time settings and freshness-checked reads", async () => {
  const settings = routeHarness({});
  assert.deepEqual((await settings.call("GET", "/api/settings/assist")).payload, { idleSeconds: 120 });
  assert.deepEqual(
    (await settings.call("PUT", "/api/settings/assist", { idleSeconds: 60, enabled: true })).payload,
    { idleSeconds: 60 },
  );

  const fresh: SessionAssist = { recap: "r", suggestion: "s", atSeq: 7, generatedAt: 1 };
  assert.equal((await routeHarness({}).call("GET", "/api/sessions/nope/assist")).status, 404);
  assert.equal(
    (await routeHarness({ projections: { s1: projection("s1") }, latestSeq: 7 })
      .call("GET", "/api/sessions/s1/assist")).status,
    404,
  );
  assert.equal(
    (await routeHarness({ projections: { s1: projection("s1", fresh) }, latestSeq: 9 })
      .call("GET", "/api/sessions/s1/assist")).status,
    404,
  );
  assert.deepEqual(
    (await routeHarness({ projections: { s1: projection("s1", fresh) }, latestSeq: 7 })
      .call("GET", "/api/sessions/s1/assist")).payload,
    fresh,
  );
});
