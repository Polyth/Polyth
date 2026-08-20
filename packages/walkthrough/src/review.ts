// Structured review assessment (WP11): prompt builder + strict parser. Scores
// come only from validated JSON fields — never inferred from prose.
import type { ReviewAssessment, ReviewFinding } from "@polyth/contracts";

export const REVIEW_PROMPT_VERSION = 1;

export function buildReviewPrompt(diff: string): string {
  return [
    "Review the code change below as a senior engineer.",
    "Reply with ONLY JSON, no code fences, matching exactly:",
    '{"summary":"...","findings":[{"severity":"critical|high|medium|low","path":"...","line":1,"body":"...","confidence":0.9}],"riskScore":1,"confidenceScore":1}',
    "riskScore and confidenceScore are integers 1-5 (5 = highest risk / highest confidence).",
    "confidence per finding is 0..1. Omit path/line when a finding is not tied to a location.",
    "",
    "<diff>",
    diff.slice(0, 60_000),
    "</diff>",
  ].join("\n");
}

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);

export type ReviewParse =
  | { ok: true; assessment: ReviewAssessment }
  | { ok: false; error: string };

const asScore = (v: unknown): 1 | 2 | 3 | 4 | 5 | null => {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 1 || n > 5) return null;
  return n as 1 | 2 | 3 | 4 | 5;
};

/** Strict validation: malformed structure or out-of-range scores reject; only
 *  benign numeric noise (fractional scores, confidence overshoot) is clamped. */
export function parseReviewAssessment(raw: string): ReviewParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim());
  } catch {
    return { ok: false, error: "review response is not valid JSON" };
  }
  const r = parsed as { summary?: unknown; findings?: unknown; riskScore?: unknown; confidenceScore?: unknown };
  if (typeof r.summary !== "string" || !r.summary.trim()) return { ok: false, error: "missing summary" };
  const riskScore = asScore(r.riskScore);
  const confidenceScore = asScore(r.confidenceScore);
  if (riskScore === null) return { ok: false, error: "riskScore must be a number 1-5" };
  if (confidenceScore === null) return { ok: false, error: "confidenceScore must be a number 1-5" };
  if (!Array.isArray(r.findings)) return { ok: false, error: "findings must be an array" };

  const findings: ReviewFinding[] = [];
  for (const [i, f] of r.findings.entries()) {
    const ff = f as { severity?: unknown; path?: unknown; line?: unknown; body?: unknown; confidence?: unknown };
    if (typeof ff.severity !== "string" || !SEVERITIES.has(ff.severity)) {
      return { ok: false, error: `finding ${i + 1} has invalid severity` };
    }
    if (typeof ff.body !== "string" || !ff.body.trim()) return { ok: false, error: `finding ${i + 1} has no body` };
    const confidence =
      typeof ff.confidence === "number" && Number.isFinite(ff.confidence)
        ? Math.min(1, Math.max(0, ff.confidence))
        : 0.5;
    findings.push({
      severity: ff.severity as ReviewFinding["severity"],
      body: ff.body.trim().slice(0, 8_000),
      confidence,
      ...(typeof ff.path === "string" && ff.path ? { path: ff.path } : {}),
      ...(typeof ff.line === "number" && Number.isInteger(ff.line) && ff.line > 0 ? { line: ff.line } : {}),
    });
  }

  return {
    ok: true,
    assessment: {
      summary: r.summary.trim().slice(0, 8_000),
      findings,
      riskScore,
      confidenceScore,
    },
  };
}
