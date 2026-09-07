/** Browser and server share this so the installer UI cannot advertise disabled sources. */
export function isSupportedInstallSource(source: string, allowDevPath = false): boolean {
  const value = source.trim();
  if (!value) return false;
  if (value.startsWith("npm:") || value.startsWith("git:") || value.startsWith("git+")) return false;
  if (value.startsWith("https://") || value.startsWith("zip:https://")) return true;
  if (value.startsWith("file:") && value.length > 5) return true;
  if (allowDevPath && (value.startsWith("path:") || value.startsWith("dir:")) && value.length > 5) return true;
  if (value.endsWith(".zip") && value.length > 4) return true;
  return false;
}
