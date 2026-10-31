declare const __POLYTH_WEB_BUILD_ID__: string;

const buildId = typeof __POLYTH_WEB_BUILD_ID__ === "string"
  ? __POLYTH_WEB_BUILD_ID__
  : "dev";

export const POLYTH_MARK_SRC = `/icon-192.png?b=${encodeURIComponent(buildId)}`;
