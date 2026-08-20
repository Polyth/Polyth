// Types for the UX-MSG-ACTIONS live-gate fixture builder (msgActionsFixtureSetup.mjs).
export declare const REPO_ROOT: string;
export declare const FIXTURE_ROOT: string;
export declare const FIXTURE_DATA: string;
export declare const FIXTURE_HOME: string;
export declare const FIXTURE_BIN: string;
export declare const OC_SEED: string;
export declare const OC_STATE: string;
export declare const PROJECT_ID: string;

export declare const SESSIONS: {
  copy: string;
  revert: string;
  fork: string;
  forkFail: string;
  forkMismatch: string;
  failed: string;
  empty: string;
  active: string;
  waiting: string;
  queued: string;
  revertActive: string;
};

export declare const TEXTS: {
  u1: string;
  a1: string;
  u2: string;
  a2: string;
  reasoning: string;
};

/** Builds (or rebuilds) the disposable fixture; returns the per-session
 *  revert/fork target sequences (the seq of each second user prompt). */
export declare function buildMsgActionsFixture(): Promise<{ targets: Record<string, number> }>;
