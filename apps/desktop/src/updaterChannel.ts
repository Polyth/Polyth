export const resolveUpdaterChannel = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined => platform === "win32" && arch === "arm64"
  ? "latest-arm64"
  : undefined;
