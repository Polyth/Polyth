// Typed client for command-line access: signed-in terminals, automation
// tokens, the terminal sign-in confirmation and the no-token trust mode. The
// server (packages/identity) owns every rule; this module only speaks HTTP.
import { authJson } from "./authClient.ts";

export type CliTokenKind = "device" | "automation";
export type CliProfile = "read" | "control";
export type CliTrustMode = "off" | "loopback" | "private-network";

export interface CliTokenSummary {
  id: string;
  kind: CliTokenKind;
  label: string;
  grants: string[];
  spaceId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revision: number;
}

export interface CliTrust {
  mode: CliTrustMode;
  revision: number;
  userId?: string;
  updatedAt?: number;
}

export interface CliAccessState {
  tokens: CliTokenSummary[];
  profiles: Record<string, string[]>;
  trust: CliTrust;
  canManageTrust: boolean;
}

export interface CliDeviceRequest {
  userCode: string;
  label: string;
  profile: string;
  grants: string[];
  clientAddress: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface CreatedCliToken {
  token: string;
  summary: CliTokenSummary;
}

type Fail = Error & { status?: number; code?: string };

const fail = (response: Response, body: Record<string, unknown>): Fail => Object.assign(
  new Error(typeof body.message === "string" ? body.message : `HTTP ${response.status}`),
  { status: response.status, code: typeof body.error === "string" ? body.error : undefined },
);

async function send<T extends Record<string, unknown>>(path: string, body: Record<string, unknown>, method = "POST"): Promise<T> {
  const result = await authJson<T>(path, body, method);
  if (!result.response.ok) throw fail(result.response, result.body as Record<string, unknown>);
  return result.body;
}

export async function loadCliAccess(): Promise<CliAccessState> {
  const response = await fetch("/api/auth/cli", { credentials: "same-origin", cache: "no-store" });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw fail(response, body);
  return {
    tokens: Array.isArray(body.tokens) ? body.tokens as CliTokenSummary[] : [],
    profiles: (body.profiles ?? { read: [], control: [] }) as Record<string, string[]>,
    trust: (body.trust ?? { mode: "off", revision: 0 }) as CliTrust,
    canManageTrust: body.canManageTrust === true,
  };
}

export const createCliToken = (input: {
  label: string; profile: CliProfile; spaceId: string | null; expiresInDays: number | null;
}): Promise<CreatedCliToken> => send<CreatedCliToken & Record<string, unknown>>("/api/auth/cli/tokens", input);

export const revokeCliToken = async (token: Pick<CliTokenSummary, "id" | "revision">): Promise<void> => {
  await send(`/api/auth/cli/tokens/${encodeURIComponent(token.id)}`, { expectedRevision: token.revision }, "DELETE");
};

export const lookupCliDevice = (userCode: string): Promise<CliDeviceRequest> =>
  send<CliDeviceRequest & Record<string, unknown>>("/api/auth/cli/device/lookup", { userCode });

export const decideCliDevice = async (userCode: string, approve: boolean): Promise<void> => {
  await send("/api/auth/cli/device/decide", { userCode, approve });
};

export const setCliTrust = (mode: CliTrustMode, expectedRevision: number): Promise<CliTrust> =>
  send<CliTrust & Record<string, unknown>>("/api/auth/cli/trust", { mode, expectedRevision });

/** Normalize typed input to the XXXX-XXXX shape; non-code input stays as typed. */
export function normalizeUserCode(raw: string): string {
  const compact = raw.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 8);
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

export const isCompleteUserCode = (code: string): boolean => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);

/** Plain-language access level for a token's grants. `control` means the
 *  grants include anything that starts or steers work. */
export function accessLevel(grants: readonly string[]): "read" | "control" {
  return grants.some((g) => /^core\.sessions\.(create|message|control|delete)$/.test(g)) ? "control" : "read";
}
