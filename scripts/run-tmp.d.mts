export declare const RUN_TMP_PREFIX: string;
export declare const RUN_TMP_OWNER_FILE: string;
export declare const ORPHAN_GRACE_MS: number;
export declare const UNOWNED_GRACE_MS: number;
export declare function sweepStaleRunTmp(options?: { base?: string; now?: number; alive?: (pid: number) => boolean }): string[];
export declare function createRunTmp(options?: { base?: string }): {
  root: string;
  env: { TMPDIR: string; TMP: string; TEMP: string };
  cleanup(): void;
};
