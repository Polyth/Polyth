import { accountState, type AccountLoginResult } from "./accounts.ts";
import { authJson } from "./authClient.ts";
import { acceptAuthenticatedBrowserAccount } from "./authPrefetch.ts";

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revision: number;
}

interface RegistrationOptionsPayload {
  challenge: string;
  rp: PublicKeyCredentialRpEntity;
  user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: Array<Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }>;
}

interface AuthenticationOptionsPayload {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
}

interface CredentialCreator {
  create(options?: CredentialCreationOptions): Promise<Credential | null>;
}
interface CredentialGetter {
  get(options?: CredentialRequestOptions): Promise<Credential | null>;
}

const invalidResponse = (): Error => Object.assign(
  new Error("Invalid passkey response from server"),
  { code: "invalid-response" },
);

const decodeBase64url = (value: unknown): Uint8Array => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidResponse();
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try { binary = atob(base64); } catch { throw invalidResponse(); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const encodeBase64url = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export function toPublicKeyCreationOptions(value: unknown): PublicKeyCredentialCreationOptions {
  if (!value || typeof value !== "object") throw invalidResponse();
  const raw = value as RegistrationOptionsPayload;
  if (!raw.rp || !raw.user || typeof raw.user.id !== "string" || !Array.isArray(raw.pubKeyCredParams)) throw invalidResponse();
  return {
    ...raw,
    challenge: decodeBase64url(raw.challenge),
    user: { ...raw.user, id: decodeBase64url(raw.user.id) },
    excludeCredentials: (raw.excludeCredentials ?? []).map((entry) => ({
      ...entry,
      id: decodeBase64url(entry.id),
    })),
  };
}

export function toPublicKeyRequestOptions(value: unknown): PublicKeyCredentialRequestOptions {
  if (!value || typeof value !== "object") throw invalidResponse();
  const raw = value as AuthenticationOptionsPayload;
  return {
    ...raw,
    challenge: decodeBase64url(raw.challenge),
  };
}

const publicKeyCredential = (value: Credential | null): PublicKeyCredential => {
  if (!value || value.type !== "public-key" || !("rawId" in value) || !("response" in value)) {
    throw Object.assign(new Error("Passkey operation was cancelled"), { code: "passkey-cancelled" });
  }
  return value as PublicKeyCredential;
};

const registrationResponse = (credential: PublicKeyCredential, name: string): Record<string, unknown> => {
  const response = credential.response as AuthenticatorAttestationResponse;
  if (!(response.clientDataJSON instanceof ArrayBuffer) || !(response.attestationObject instanceof ArrayBuffer)) {
    throw invalidResponse();
  }
  return {
    name,
    credentialId: encodeBase64url(credential.rawId),
    clientDataJSON: encodeBase64url(response.clientDataJSON),
    attestationObject: encodeBase64url(response.attestationObject),
  };
};

const authenticationResponse = (credential: PublicKeyCredential): Record<string, unknown> => {
  const response = credential.response as AuthenticatorAssertionResponse;
  if (!(response.clientDataJSON instanceof ArrayBuffer)
    || !(response.authenticatorData instanceof ArrayBuffer)
    || !(response.signature instanceof ArrayBuffer)) {
    throw invalidResponse();
  }
  return {
    credentialId: encodeBase64url(credential.rawId),
    clientDataJSON: encodeBase64url(response.clientDataJSON),
    authenticatorData: encodeBase64url(response.authenticatorData),
    signature: encodeBase64url(response.signature),
    userHandle: response.userHandle instanceof ArrayBuffer ? encodeBase64url(response.userHandle) : null,
  };
};

const credentialApi = (): CredentialsContainer => {
  if (typeof navigator === "undefined" || !navigator.credentials) {
    throw Object.assign(new Error("Passkeys are not supported by this browser"), { code: "unsupported" });
  }
  return navigator.credentials;
};

export const browserSupportsPasskeys = (): boolean =>
  typeof PublicKeyCredential !== "undefined"
  && typeof navigator !== "undefined"
  && !!navigator.credentials;

const authFailure = (
  response: Response,
  body: { error?: string; message?: string; retryAfterSec?: number },
): AccountLoginResult => {
  const retryHeader = Number(response.headers.get("retry-after"));
  return {
    ok: false,
    ...(body.error ? { error: body.error } : {}),
    ...(body.message ? { message: body.message } : {}),
    ...(typeof body.retryAfterSec === "number"
      ? { retryAfterSec: body.retryAfterSec }
      : Number.isFinite(retryHeader) && retryHeader > 0 ? { retryAfterSec: retryHeader } : {}),
  };
};

const httpError = (response: Response, body: Record<string, unknown>): Error => Object.assign(
  new Error(typeof body.message === "string"
    ? body.message
    : typeof body.error === "string" ? body.error.replace(/-/g, " ") : `HTTP ${response.status}`),
  { status: response.status, code: typeof body.error === "string" ? body.error : undefined },
);

export async function signInWithPasskey(
  credentials: CredentialGetter = credentialApi(),
): Promise<AccountLoginResult> {
  const begin = await authJson<AuthenticationOptionsPayload & Record<string, unknown>>(
    "/api/auth/passkeys/authenticate/options",
    {},
  );
  if (!begin.response.ok) return authFailure(begin.response, begin.body);

  let credential: PublicKeyCredential;
  try {
    credential = publicKeyCredential(await credentials.get({
      publicKey: toPublicKeyRequestOptions(begin.body),
    }));
  } catch (error) {
    if (error instanceof DOMException && ["NotAllowedError", "AbortError"].includes(error.name)) {
      return { ok: false, error: "passkey-cancelled", message: "Passkey sign-in was cancelled." };
    }
    if ((error as { code?: unknown } | null)?.code === "passkey-cancelled") {
      return { ok: false, error: "passkey-cancelled", message: "Passkey sign-in was cancelled." };
    }
    throw error;
  }

  const complete = await authJson<{
    ok?: unknown; error?: string; message?: string; retryAfterSec?: number;
  }>("/api/auth/passkeys/authenticate/complete", authenticationResponse(credential));
  if (!complete.response.ok) return authFailure(complete.response, complete.body);

  // The cookie is authoritative. Align browser-local persistence when possible;
  // bootstrap performs the same protected account lookup after a reload.
  try {
    const state = await accountState();
    acceptAuthenticatedBrowserAccount(state.currentAccountId);
  } catch { /* bootstrap will resolve the authenticated account namespace */ }
  return { ok: true };
}

export async function listPasskeys(): Promise<PasskeySummary[]> {
  const response = await fetch("/api/auth/passkeys", { cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { passkeys?: unknown; message?: unknown; error?: unknown };
  if (!response.ok) throw httpError(response, body as Record<string, unknown>);
  if (!Array.isArray(body.passkeys)) throw invalidResponse();
  return body.passkeys as PasskeySummary[];
}

export async function registerPasskey(
  name: string,
  credentials: CredentialCreator = credentialApi(),
): Promise<PasskeySummary> {
  const label = name.trim();
  if (!label) throw Object.assign(new Error("Passkey name is required"), { code: "invalid-input" });
  const begin = await authJson<RegistrationOptionsPayload & Record<string, unknown>>(
    "/api/auth/passkeys/register/options",
    { name: label },
  );
  if (!begin.response.ok) throw httpError(begin.response, begin.body);

  let credential: PublicKeyCredential;
  try {
    credential = publicKeyCredential(await credentials.create({
      publicKey: toPublicKeyCreationOptions(begin.body),
    }));
  } catch (error) {
    if (error instanceof DOMException && ["NotAllowedError", "AbortError"].includes(error.name)) {
      throw Object.assign(new Error("Passkey registration was cancelled"), { code: "passkey-cancelled" });
    }
    throw error;
  }

  const complete = await authJson<PasskeySummary & Record<string, unknown>>(
    "/api/auth/passkeys/register/complete",
    registrationResponse(credential, label),
  );
  if (!complete.response.ok) throw httpError(complete.response, complete.body);
  return complete.body as unknown as PasskeySummary;
}

export async function removePasskey(passkey: Pick<PasskeySummary, "id" | "revision">): Promise<void> {
  if (!passkey.id || !Number.isSafeInteger(passkey.revision) || passkey.revision < 1) {
    throw Object.assign(new Error("Passkey revision is missing; refresh before removing"), { code: "conflict" });
  }
  const result = await authJson(
    `/api/auth/passkeys/${encodeURIComponent(passkey.id)}`,
    { expectedRevision: passkey.revision },
    "DELETE",
  );
  if (!result.response.ok) throw httpError(result.response, result.body);
}
