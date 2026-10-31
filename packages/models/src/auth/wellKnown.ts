import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";

export interface WellKnownAuthDocument {
  origin: string;
  hash: string;
  command: string[];
  env: string;
}

export type WellKnownValidation =
  | { ok: true; document: WellKnownAuthDocument }
  | { ok: false; reason: string };

const MAX_BYTES = 64 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** OpenCode stores the reviewed URL with trailing slashes stripped, including path. */
export const normalizeOrigin = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    url.search = "";
    url.hash = "";
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path && path !== "/" ? path : ""}`;
  } catch {
    return undefined;
  }
};

export const wellKnownUrl = (origin: string): string => `${origin}/.well-known/opencode`;

export const isEnvVarName = (value: unknown): value is string =>
  typeof value === "string" && ENV_NAME.test(value) && value.length <= 256;

export const hashWellKnownPayload = (payload: {
  origin: string;
  command: readonly string[];
  env: string;
}): string =>
  createHash("sha256").update(canonicalJson({
    origin: payload.origin,
    command: payload.command,
    env: payload.env,
  })).digest("hex");

export const validateWellKnownDocument = (
  origin: string,
  payload: unknown,
  contentType: string | undefined,
  status: number,
): WellKnownValidation => {
  if (status < 200 || status >= 300) {
    return { ok: false, reason: `Discovery returned HTTP ${status}.` };
  }
  const type = (contentType ?? "").toLowerCase();
  if (type && !type.includes("json") && !type.includes("javascript")) {
    return { ok: false, reason: "Discovery did not return JSON." };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "Discovery payload is not a JSON object." };
  }
  const record = payload as Record<string, unknown>;
  const auth = record.auth !== undefined && record.auth !== null && typeof record.auth === "object" && !Array.isArray(record.auth)
    ? record.auth as Record<string, unknown>
    : undefined;
  if (!auth) return { ok: false, reason: "Discovery document is missing auth." };
  if (!Array.isArray(auth.command) || auth.command.length === 0 || auth.command.some((item) => typeof item !== "string" || !item || /[\0\n\r]/.test(item))) {
    return { ok: false, reason: "auth.command must be a non-empty array of strings." };
  }
  if (!isEnvVarName(auth.env)) {
    return { ok: false, reason: "auth.env must be a valid environment variable name." };
  }
  const command = auth.command as string[];
  const env = auth.env;
  return {
    ok: true,
    document: {
      origin,
      hash: hashWellKnownPayload({ origin, command, env }),
      command,
      env,
    },
  };
};

export const MAX_WELLKNOWN_BYTES = MAX_BYTES;
