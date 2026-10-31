import test from "node:test";
import assert from "node:assert/strict";
import { restartAssessmentSkips } from "../src/opencodeRestartSafety.ts";
import type { RuntimeRestartFingerprint } from "../src/sessions.ts";

const fingerprint: RuntimeRestartFingerprint = {
  authorityId: "owned:opencode-auth-1",
  generation: 5,
};

test("antigravity/claude-resolved session skipped even without a binding (the 1dc708d8 case)", () => {
  const antigravityProjection = {
    resolvedHarnessId: "antigravity",
  };
  assert.equal(restartAssessmentSkips(antigravityProjection, fingerprint), true);

  const claudeProjection = {
    resolvedHarnessId: "claude",
  };
  assert.equal(restartAssessmentSkips(claudeProjection, fingerprint), true);
});

test("pinned non-opencode skipped", () => {
  const pinnedClaude = {
    harness: { mode: "pinned" as const, harnessId: "claude" },
  };
  assert.equal(restartAssessmentSkips(pinnedClaude, fingerprint), true);

  const pinnedCodex = {
    harness: { mode: "pinned" as const, harnessId: "codex" },
  };
  assert.equal(restartAssessmentSkips(pinnedCodex, fingerprint), true);
});

test("opencode-resolved unbound NOT skipped", () => {
  const opencodeUnbound = {
    resolvedHarnessId: "opencode",
  };
  assert.equal(restartAssessmentSkips(opencodeUnbound, fingerprint), false);

  const pinnedOpenCodeUnbound = {
    harness: { mode: "pinned" as const, harnessId: "opencode" },
  };
  assert.equal(restartAssessmentSkips(pinnedOpenCodeUnbound, fingerprint), false);
});

test("unknown-harness unbound NOT skipped", () => {
  const unknownUnbound = {};
  assert.equal(restartAssessmentSkips(unknownUnbound, fingerprint), false);

  const autoUnbound = {
    harness: { mode: "auto" as const },
  };
  assert.equal(restartAssessmentSkips(autoUnbound, fingerprint), false);
});

test("bound to other generation skipped", () => {
  const otherGeneration = {
    resolvedHarnessId: "opencode",
    runtimeBinding: {
      authorityId: fingerprint.authorityId,
      generation: 4,
    },
  };
  assert.equal(restartAssessmentSkips(otherGeneration, fingerprint), true);

  const otherAuthority = {
    resolvedHarnessId: "opencode",
    runtimeBinding: {
      authorityId: "owned:foreign-authority",
      generation: fingerprint.generation,
    },
  };
  assert.equal(restartAssessmentSkips(otherAuthority, fingerprint), true);
});

test("bound to this generation NOT skipped", () => {
  const currentGen = {
    resolvedHarnessId: "opencode",
    runtimeBinding: {
      authorityId: fingerprint.authorityId,
      generation: fingerprint.generation,
    },
  };
  assert.equal(restartAssessmentSkips(currentGen, fingerprint), false);

  const autoCurrentGen = {
    harness: { mode: "auto" as const },
    runtimeBinding: {
      authorityId: fingerprint.authorityId,
      generation: fingerprint.generation,
    },
  };
  assert.equal(restartAssessmentSkips(autoCurrentGen, fingerprint), false);
});
