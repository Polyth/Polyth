import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HarnessSnapshot } from "@polyth/contracts";
import { readHarnessSnapshots } from "@polyth/models/runtime-catalog";
import { needsReadinessCheck } from "./presentation.ts";

/** Native checks start processes (an App Server, an RPC child, a model
 *  listing); two at a time keeps opening Settings light. */
const LANES = 2;
/** A check that has not answered by then leaves its row "Not verified" and
 *  frees its lane; the server keeps working and caches what it learns. */
const CHECK_TIMEOUT_MS = 45_000;

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("readiness check timed out")), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
});

const checkKey = (round: number, row: HarnessSnapshot) =>
  JSON.stringify([round, row.identity.id, row.identity.version ?? ""]);

/**
 * Settings is where a person asks "is this harness ready?", so it does not
 * stop at a cheap probe that cannot see sign-in. Each enabled, installed
 * harness answering "unknown" is asked to check itself (its detail discovery,
 * waiting for the native answer), at most once per installed version and
 * round; `recheck` starts a new round after "Check again". The answers
 * replace those rows on this page, and the server keeps them for its listing
 * too, so the next read stays ready instead of falling back to "unknown".
 */
export function useReadinessChecks(rows: HarnessSnapshot[], scope: { projectId?: string | null; spaceId?: string; enabled: boolean }) {
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  const [answers, setAnswers] = useState<ReadonlyMap<string, HarnessSnapshot>>(() => new Map());
  const [round, setRound] = useState(0);
  const attempted = useRef(new Set<string>());
  const lanes = useRef<Array<Promise<void>>>(Array.from({ length: LANES }, () => Promise.resolve()));
  const next = useRef(0);
  const live = useRef(true);
  const scopeKey = JSON.stringify([scope.projectId ?? "", scope.spaceId ?? ""]);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  // A check from an earlier round (before Check again) may still answer; it
  // must not end the new round's "Checking…" for the same harness.
  const currentRound = useRef(round);
  currentRound.current = round;

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  // A different project is a different execution context: forget answers.
  useEffect(() => {
    attempted.current.clear();
    setAnswers(new Map());
    setChecking(new Set());
  }, [scopeKey]);

  useEffect(() => {
    if (!scope.enabled) return;
    const candidates = rows.filter((row) => needsReadinessCheck(row) && !attempted.current.has(checkKey(round, row)));
    if (candidates.length === 0) return;
    for (const row of candidates) attempted.current.add(checkKey(round, row));
    const ids = candidates.map((row) => row.identity.id);
    setChecking((previous) => new Set([...previous, ...ids]));
    const askedFor = scopeKey;
    const askedRound = round;
    const current = () => live.current && currentScope.current === askedFor && currentRound.current === askedRound;
    for (const id of ids) {
      const lane = next.current++ % LANES;
      lanes.current[lane] = lanes.current[lane]!.then(async () => {
        if (!current()) return;
        try {
          const [answer] = await withTimeout(readHarnessSnapshots({ projectId: scope.projectId, spaceId: scope.spaceId, harnessId: id, verify: true }), CHECK_TIMEOUT_MS);
          if (answer && current()) {
            setAnswers((previous) => new Map(previous).set(id, answer));
          }
        } catch {
          // The row keeps its cheap answer ("Not verified"); a transport
          // failure or a slow native check is not a harness problem.
        } finally {
          if (current()) {
            setChecking((previous) => {
              const remaining = new Set(previous);
              remaining.delete(id);
              return remaining;
            });
          }
        }
      });
    }
  }, [rows, round, scope.enabled, scope.projectId, scope.spaceId, scopeKey]);

  const recheck = useCallback(() => {
    setAnswers(new Map());
    setChecking(new Set());
    setRound((value) => value + 1);
  }, []);

  /** Summary rows with this page's newer native answers laid over them. The
   *  summary's policy wins: toggles and reorders land there. */
  const merged = useMemo(() => rows.map((row) => {
    const answer = answers.get(row.identity.id);
    return answer && answer.availability.checkedAt >= row.availability.checkedAt
      ? { ...answer, policy: row.policy }
      : row;
  }), [rows, answers]);

  return { rows: merged, checking, recheck };
}
