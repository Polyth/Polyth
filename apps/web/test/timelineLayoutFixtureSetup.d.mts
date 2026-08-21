// Types for the UX-TIMELINE-LAYOUT-01 live-gate fixture builder
// (timelineLayoutFixtureSetup.mjs).
export declare const REPO_ROOT: string;
export declare const FIXTURE_ROOT: string;
export declare const FIXTURE_DATA: string;
export declare const FIXTURE_HOME: string;
export declare const FIXTURE_BIN: string;
export declare const OC_SEED: string;
export declare const OC_STATE: string;
export declare const PROJECT_ID: string;

export declare const SESSIONS: {
  rich: string;
  many: string;
  empty: string;
  stream: string;
};

export declare const MANY_TURNS: number;

export declare const TEXTS: {
  u1: string; a1: string;
  u2: string; a2: string;
  reasoning: string;
  u3: string; a3: string;
  u4: string; a4: string;
  u5: string; a5: string;
  u6: string; a6: string;
};

/** Builds (or rebuilds) the disposable timeline-layout fixture. */
export declare function buildTimelineLayoutFixture(): Promise<Record<string, never>>;
