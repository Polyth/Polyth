const WINDOWS_ABS = /^[A-Za-z]:[\\/]/;
const UNC = /^\\\\/;

/** Local package asset path: relative, inside the package, no tricks. */
export function isSafePackagePath(value: string): boolean {
  if (typeof value !== "string" || !value) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || WINDOWS_ABS.test(value) || UNC.test(value)) return false;
  if (value.includes("://")) return false;
  const segments = value.replace(/^\.\//, "").split("/");
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return false;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.replace(/^\.\//, ""));
}

export function assertSafePackagePath(value: string, field: string): string {
  const trimmed = value.trim();
  if (!isSafePackagePath(trimmed)) {
    throw Object.assign(
      new Error(`${field} must be a relative path inside the package`),
      { code: "invalid-input" },
    );
  }
  return trimmed.replace(/^\.\//, "");
}

export function isHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && value === parsed.origin;
  } catch {
    return false;
  }
}

export function isHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}
