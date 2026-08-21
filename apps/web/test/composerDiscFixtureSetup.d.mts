// Hand-written declarations for the .mjs fixture module (tsc gate).
export declare const REPO_ROOT: string;
export declare const FIXTURE_ROOT: string;
export declare const FIXTURE_DATA: string;
export declare const FIXTURE_HOME: string;
export declare const FIXTURE_BIN: string;
export declare const OC_SEED: string;
export declare const OC_STATE: string;
export declare const PROJECT_ID: string;
export declare const GH_OWNER: string;
export declare const GH_NAME: string;

export declare const SESSIONS: {
  main: string;
  active: string;
};

export declare function buildComposerDiscFixture(): Promise<void>;
