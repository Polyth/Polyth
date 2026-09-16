import { validateAuthStatus, type BrowserAuthStatus } from "./authBootstrap.ts";

let csrfToken: string | null = null;

const rememberCsrf = (value: unknown): void => {
  if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) csrfToken = value;
};

export async function fetchAuthStatus(): Promise<BrowserAuthStatus> {
  const response = await fetch("/api/auth/status", { cache: "no-store" });
  if (!response.ok) throw Object.assign(new Error(`auth status: HTTP ${response.status}`), { status: response.status });
  const raw = await response.json() as unknown;
  const marked = raw && typeof raw === "object" && !Array.isArray(raw)
    ? {
        ...(raw as Record<string, unknown>),
        ...(response.headers.get("x-polyth-bootstrap") === "setup" ? { bootstrapMode: "setup" } : {}),
      }
    : raw;
  const status = validateAuthStatus(marked);
  rememberCsrf(status.csrfToken);
  return status;
}

export interface AuthJsonResult<T extends Record<string, unknown> = Record<string, unknown>> {
  response: Response;
  body: T;
}

/** Canonical mutations require the nonce minted by auth/status. Legacy servers
 * ignore the extra header, so this remains compatible during rolling upgrades. */
export async function authJson<T extends Record<string, unknown> = Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
  method = "POST",
): Promise<AuthJsonResult<T>> {
  if (!csrfToken) await fetchAuthStatus();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrfToken) headers["x-polyth-csrf"] = csrfToken;
  const response = await fetch(path, {
    method,
    headers,
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const payload = await response.json().catch(() => ({})) as T;
  rememberCsrf((payload as Record<string, unknown>).csrfToken);
  return { response, body: payload };
}

export function clearAuthCsrf(): void {
  csrfToken = null;
}
