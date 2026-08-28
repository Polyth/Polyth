// Regression tests for OC-REAL-020 / OC-REAL-023.
// See docs/opencode-hardening/FAILURE-REPORT-LEGACY-TERMINALIZATION.md.
//
// Real OpenCode 1.18.18 legacy payloads carry NO comparable revision field
// (revision/version/seq/sequence/updatedAt). The payload literals below were
// captured from a live `opencode serve` wire
// (artifacts/opencode-real-world/phase-1-legacy/OC-REAL-020/completion.json).
import { test } from "node:test";
import assert from "node:assert";
import type { OpenCodeTransport, RuntimeEndpoint } from "@polyth/contracts";
import { terminalStateEvidenceOf } from "../src/events.ts";
import { createLegacyProtocolAdapter } from "../src/protocolLegacy.ts";

// Exact live shape: session.idle carries only the session id.
const REAL_SESSION_IDLE = {
  type: "session.idle",
  properties: { sessionID: "ses_fb92xxxxxxxxxxxxxxxxxxxxxx" },
} as const;

// Exact live shape: session.error carries name/data but no revision.
const REAL_SESSION_ERROR = {
  type: "session.error",
  properties: {
    sessionID: "ses_fb92xxxxxxxxxxxxxxxxxxxxxx",
    error: { name: "APIError", data: { message: "API key not valid." } },
  },
} as const;

test("OC-REAL-020: real 1.18.18 session.idle (no revision) must yield terminal evidence", () => {
  const evidence = terminalStateEvidenceOf(REAL_SESSION_IDLE as never);
  assert.ok(
    evidence && evidence.state === "idle",
    "real legacy session.idle has no revision field, so terminalStateEvidenceOf returns undefined "
      + "and no turn ever terminalizes against a real backend (missed completion)",
  );
});

test("OC-REAL-021: real 1.18.18 session.error (no revision) must yield terminal evidence", () => {
  const evidence = terminalStateEvidenceOf(REAL_SESSION_ERROR as never);
  assert.ok(
    evidence && evidence.state === "failed",
    "real legacy session.error has no revision field, so failed turns are never terminalized locally",
  );
});

test("OC-REAL-023: status absence terminalizes only with durable assistant completion", async () => {
  let history: unknown[] = [];
  const transport: OpenCodeTransport = {
    async query<T>(request: {
      method: "GET" | "HEAD";
      path: string;
      deadlineMs: number;
    }): Promise<T> {
      if (request.path.startsWith("/session/status")) return {} as T;
      if (request.path.includes("/message?")) return history as T;
      if (request.path.startsWith("/permission") || request.path.startsWith("/question")) {
        return [] as T;
      }
      throw new Error(`unexpected query ${request.path}`);
    },
    async mutate() {
      throw new Error("reconciliation must not mutate");
    },
    async stream() {},
  };
  const endpoint: RuntimeEndpoint = {
    authorityId: "real-legacy-test",
    continuity: "generation-only",
    generation: 1,
    url: "http://opencode.test",
    location: { directory: "/workspace/project" },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  };
  const adapter = createLegacyProtocolAdapter({
    transport,
    endpoint,
    promptPaths: ["prompt_async"],
  });
  const binding = {
    canonicalSessionId: "canonical-real",
    backendSessionId: "ses_fb92xxxxxxxxxxxxxxxxxxxxxx",
    authorityId: endpoint.authorityId,
    generation: endpoint.generation,
    continuity: endpoint.continuity,
    location: endpoint.location,
  };

  assert.deepEqual(
    (await adapter.reconcile({ ...binding, reconciliationOrdinal: 1 })).state,
    { value: "unknown" },
    "successful absence from the busy map is not terminal evidence by itself",
  );

  history = [{
    info: {
      id: "msg_assistant",
      role: "assistant",
      time: { created: 1787894837582, completed: 1787894839755 },
    },
    parts: [{
      id: "part_text",
      type: "text",
      text: "DONE-MARKER-020",
      time: { start: 1787894839719, end: 1787894839746 },
    }],
  }];
  assert.deepEqual(
    (await adapter.reconcile({ ...binding, reconciliationOrdinal: 2 })).state,
    {
      value: "idle",
      watermark: "1787894839755",
      comparison: {
        domain: "legacy-history:assistant-completed",
        order: 1787894839755,
      },
    },
  );
});
