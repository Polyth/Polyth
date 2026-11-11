// The catalog's data contract. One manifest is one folder
// (`catalog/<id>/integration.json`), the folder name is the entry id, and the
// field names follow the official MCP Registry `server.json` where they
// overlap so an importer can normalize into this shape later.
//
// This module is pure: the browser needs these rules to render and validate,
// the server needs them to refuse a broken manifest. Filesystem access lives in
// `entries.ts`, which only the server imports.

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ID_LENGTH = 48;
const MAX_SUMMARY = 160;
const MAX_DESCRIPTION = 900;

/** Filter chips, in the order the page shows them. */
export const CATEGORY_ORDER = [
  "product",
  "code",
  "design",
  "cloud",
  "data",
  "quality",
  "ai",
  "business",
  "automation",
  "other",
] as const;

export type IntegrationCategory = (typeof CATEGORY_ORDER)[number];

/** How the endpoint proves who is calling. `none` covers no-auth remotes and
 *  local servers. */
export type IntegrationAuth = "oauth" | "token" | "none";

export type IntegrationStatus = "stable" | "beta";

export interface IntegrationRemoteEndpoint {
  /** May carry `{inputId}` tokens, each declared in `mcp.inputs`. */
  url: string;
  /** For `auth: "token"`: the header the token travels in. */
  tokenHeader?: { name: string; valuePrefix?: string };
  /** True when the server works without a token but a key raises limits. */
  tokenOptional?: boolean;
}

export interface IntegrationLocalEndpoint {
  /** Exact command, pinned to an exact version. Arguments may carry
   *  `{inputId}` tokens, each declared in `mcp.inputs`. */
  command: [string, ...string[]];
  /** First run downloads a package, so the default startup timeout is too tight. */
  timeoutMs?: number;
  requires?: Array<"node" | "python" | "docker">;
}

/** One allowed value of a choice input. */
export interface IntegrationInputChoice {
  value: string;
  label: string;
}

/**
 * A value the person supplies before connecting — a region, a site, an
 * organization — interpolated where the endpoint says `{id}`. Exactly one of
 * `choices` and `pattern` bounds it, and an input that lands in a URL's host
 * must be a choice: a typed value must never decide which server receives the
 * sign-in or the key.
 */
export interface IntegrationInput {
  id: string;
  label: string;
  /** Shown under the field. */
  hint?: string;
  placeholder?: string;
  /** Preselected value; must itself be valid. */
  default?: string;
  choices?: IntegrationInputChoice[];
  /** Anchored (`^…$`) pattern for a free-text value. */
  pattern?: string;
}

export interface IntegrationMcp {
  auth: IntegrationAuth;
  /** Exactly one of `remote` and `local` is present. */
  remote?: IntegrationRemoteEndpoint;
  local?: IntegrationLocalEndpoint;
  /** Where the user creates a token, for `auth: "token"`. */
  tokenHelpUrl?: string;
  /** Values the endpoint interpolates. */
  inputs?: IntegrationInput[];
}

/** A skill the vendor publishes for use next to its server. */
export interface IntegrationSkill {
  /** Git source the skills installer accepts, e.g. `openai/skills`. */
  source: string;
  subpath: string;
  name: string;
}

/** What was actually checked, so a stale claim is visible instead of implied. */
export interface IntegrationEvidence {
  /** ISO date of the last check. */
  checkedAt: string;
  /** Where the claim comes from: vendor documentation, usually. */
  source: string;
  probe: {
    /** `observed`: this repository answered a request; `documented`: read in
     *  vendor docs only; `pending`: not checked yet. */
    state: "observed" | "documented" | "pending";
    httpStatus?: number;
    challenge?: "bearer-oauth" | "bearer" | "none" | "unknown";
    /** For an OAuth challenge: whether the authorization server lets a client
     *  register itself (`dynamic`), accepts a client metadata document only, or
     *  needs an app registered by hand. One-click sign-in needs `dynamic`. */
    registration?: "dynamic" | "metadata-document" | "none";
    note?: string;
  };
}

export interface IntegrationManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  publisher: string;
  /** True when the endpoint is run by the service itself. */
  verified: boolean;
  /** One line: what the agent can do with it. */
  summary: string;
  description: string;
  categories: [IntegrationCategory, ...IntegrationCategory[]];
  status: IntegrationStatus;
  featured?: boolean;
  homepage: string;
  mcp: IntegrationMcp;
  skills?: IntegrationSkill[];
  evidence: IntegrationEvidence;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isHttpsUrl = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
};

const isSafePath = (value: unknown): boolean =>
  typeof value === "string"
  && value.length > 0
  && !value.includes("\\")
  && !value.startsWith("/")
  && !value.split("/").includes("..");

/**
 * Every reason this manifest cannot ship. An empty list means valid. The
 * message names the field, because a broken manifest fails a test, not a user.
 */
export function validateManifest(value: unknown, expectedId: string): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ["manifest must be a JSON object"];

  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");

  const id = value.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id) || id.length > MAX_ID_LENGTH) {
    errors.push(`id must be a kebab-case id up to ${MAX_ID_LENGTH} characters`);
  } else if (id !== expectedId) {
    errors.push(`id "${id}" must match the folder name "${expectedId}"`);
  }

  for (const field of ["name", "publisher"] as const) {
    const text = value[field];
    if (typeof text !== "string" || !text.trim() || text.length > 80) {
      errors.push(`${field} must be a non-empty string up to 80 characters`);
    }
  }

  if (typeof value.verified !== "boolean") errors.push("verified must be a boolean");

  const summary = value.summary;
  if (typeof summary !== "string" || !summary.trim()) errors.push("summary must be a non-empty string");
  else if (summary.length > MAX_SUMMARY) errors.push(`summary must be at most ${MAX_SUMMARY} characters`);

  const description = value.description;
  if (typeof description !== "string" || description.trim().length < 20) {
    errors.push("description must be a sentence of at least 20 characters");
  } else if (description.length > MAX_DESCRIPTION) {
    errors.push(`description must be at most ${MAX_DESCRIPTION} characters`);
  }

  const categories = value.categories;
  if (!Array.isArray(categories) || categories.length === 0 || categories.length > 2) {
    errors.push("categories must hold one or two categories");
  } else {
    const seen = new Set<string>();
    for (const category of categories) {
      if (typeof category !== "string" || !(CATEGORY_ORDER as readonly string[]).includes(category)) {
        errors.push(`unknown category "${String(category)}"`);
      } else if (seen.has(category)) {
        errors.push(`duplicate category "${category}"`);
      }
      seen.add(String(category));
    }
  }

  if (value.status !== "stable" && value.status !== "beta") errors.push("status must be stable or beta");
  if (value.featured !== undefined && typeof value.featured !== "boolean") errors.push("featured must be a boolean");
  if (!isHttpsUrl(value.homepage)) errors.push("homepage must be an https URL");

  errors.push(...validateMcp(value.mcp));
  if (value.skills !== undefined) errors.push(...validateSkills(value.skills));
  errors.push(...validateEvidence(value.evidence));

  return errors;
}

function validateMcp(value: unknown): string[] {
  if (!isObject(value)) return ["mcp must be an object"];
  const errors: string[] = [];
  if (value.auth !== "oauth" && value.auth !== "token" && value.auth !== "none") {
    errors.push("mcp.auth must be oauth, token or none");
  }
  const hasRemote = value.remote !== undefined;
  const hasLocal = value.local !== undefined;
  if (hasRemote === hasLocal) errors.push("mcp needs exactly one of remote and local");

  if (hasRemote) {
    if (!isObject(value.remote)) {
      errors.push("mcp.remote must be an object");
    } else {
      const remote = value.remote;
      if (typeof remote.url !== "string" || !isHttpsUrl(remote.url.replace(INPUT_TOKEN, "x"))) {
        errors.push("mcp.remote.url must be an https URL");
      }
      if (remote.tokenHeader !== undefined) {
        if (value.auth !== "token") errors.push("mcp.remote.tokenHeader only applies to auth \"token\"");
        if (!isObject(remote.tokenHeader)) errors.push("mcp.remote.tokenHeader must be an object");
        else {
          const header = remote.tokenHeader;
          if (typeof header.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(header.name)) {
            errors.push("mcp.remote.tokenHeader.name must be an HTTP header name");
          }
          if (header.valuePrefix !== undefined && typeof header.valuePrefix !== "string") {
            errors.push("mcp.remote.tokenHeader.valuePrefix must be a string");
          }
        }
      }
      if (remote.tokenOptional !== undefined && typeof remote.tokenOptional !== "boolean") {
        errors.push("mcp.remote.tokenOptional must be a boolean");
      }
      if (value.auth === "oauth" && remote.tokenHeader !== undefined) {
        errors.push("an oauth remote does not take a tokenHeader");
      }
    }
  }

  if (hasLocal) {
    if (!isObject(value.local)) {
      errors.push("mcp.local must be an object");
    } else {
      const local = value.local;
      const command = local.command;
      if (!Array.isArray(command) || command.length === 0
        || command.length > 16
        || command.some((part) => typeof part !== "string" || !part.trim())) {
        errors.push("mcp.local.command must be a non-empty array of strings");
      }
      if (value.auth === "oauth") errors.push("a local server cannot use oauth");
      if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
        errors.push(...localPinningErrors(command as string[]));
      }
      if (local.requires !== undefined) {
        const allowed = new Set(["node", "python", "docker"]);
        if (!Array.isArray(local.requires) || local.requires.some((item) => !allowed.has(String(item)))) {
          errors.push("mcp.local.requires may list node, python or docker");
        }
      }
      if (local.timeoutMs !== undefined) {
        if (typeof local.timeoutMs !== "number" || !Number.isFinite(local.timeoutMs)
          || local.timeoutMs < 1000 || local.timeoutMs > 300000) {
          errors.push("mcp.local.timeoutMs must be 1000..300000");
        }
      }
    }
  }

  errors.push(...validateInputs(value));

  if (value.tokenHelpUrl !== undefined && !isHttpsUrl(value.tokenHelpUrl)) {
    errors.push("mcp.tokenHelpUrl must be an https URL");
  }
  if (value.auth === "token" && value.tokenHelpUrl === undefined && hasRemote) {
    errors.push("a token remote must say where the token is created (mcp.tokenHelpUrl)");
  }
  return errors;
}

/** `{region}` inside a URL or a command argument. */
const INPUT_TOKEN = /\{([a-z][a-zA-Z0-9]*)\}/g;
const INPUT_ID = /^[a-z][a-zA-Z0-9]{0,31}$/;
/** What any input value may contain, whatever its own rule says: no
 *  separators, no URL syntax, no shell syntax. */
export const INPUT_VALUE_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The `{id}` tokens a template uses, in order of first use. */
export function inputTokens(template: string): string[] {
  return [...new Set([...template.matchAll(INPUT_TOKEN)].map((match) => match[1]!))];
}

/** True when `{id}` sits in the host part of an endpoint URL. */
function tokenInHost(url: string, id: string): boolean {
  const afterScheme = url.replace(/^https:\/\//, "");
  const host = afterScheme.split("/")[0] ?? "";
  return host.includes(`{${id}}`);
}

function validateInputs(mcp: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const remote = isObject(mcp.remote) && typeof mcp.remote.url === "string" ? mcp.remote.url : undefined;
  const local = isObject(mcp.local) && Array.isArray(mcp.local.command)
    ? (mcp.local.command as unknown[]).filter((part): part is string => typeof part === "string")
    : [];
  const used = new Set([
    ...(remote ? inputTokens(remote) : []),
    ...local.flatMap((part) => inputTokens(part)),
  ]);
  if (local[0] && inputTokens(local[0]).length > 0) errors.push("mcp.local.command[0] cannot carry an input");

  if (mcp.inputs === undefined) {
    for (const id of used) errors.push(`{${id}} is used but not declared in mcp.inputs`);
    return errors;
  }
  if (!Array.isArray(mcp.inputs) || mcp.inputs.length === 0 || mcp.inputs.length > 4) {
    return [...errors, "mcp.inputs must hold one to four inputs"];
  }
  const declared = new Set<string>();
  for (const [index, input] of mcp.inputs.entries()) {
    const at = `mcp.inputs[${index}]`;
    if (!isObject(input)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const id = input.id;
    if (typeof id !== "string" || !INPUT_ID.test(id)) {
      errors.push(`${at}.id must be a camelCase identifier`);
      continue;
    }
    if (declared.has(id)) errors.push(`duplicate input "${id}"`);
    declared.add(id);
    if (!used.has(id)) errors.push(`input "${id}" is declared but the endpoint never uses {${id}}`);
    if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 60) {
      errors.push(`${at}.label must be a non-empty string up to 60 characters`);
    }
    for (const field of ["hint", "placeholder"] as const) {
      if (input[field] !== undefined && (typeof input[field] !== "string" || (input[field] as string).length > 160)) {
        errors.push(`${at}.${field} must be a string up to 160 characters`);
      }
    }
    const hasChoices = input.choices !== undefined;
    const hasPattern = input.pattern !== undefined;
    if (hasChoices === hasPattern) errors.push(`${at} needs exactly one of choices and pattern`);
    if (hasChoices) {
      if (!Array.isArray(input.choices) || input.choices.length === 0 || input.choices.length > 32) {
        errors.push(`${at}.choices must hold 1 to 32 choices`);
      } else {
        for (const choice of input.choices) {
          if (!isObject(choice) || typeof choice.value !== "string" || !INPUT_VALUE_SAFE.test(choice.value)
            || typeof choice.label !== "string" || !choice.label.trim()) {
            errors.push(`${at}.choices hold { value, label } with a plain value`);
            break;
          }
        }
      }
    }
    if (hasPattern) {
      if (typeof input.pattern !== "string" || !input.pattern.startsWith("^") || !input.pattern.endsWith("$")) {
        errors.push(`${at}.pattern must be anchored with ^ and $`);
      } else {
        try {
          new RegExp(input.pattern);
        } catch {
          errors.push(`${at}.pattern is not a valid regular expression`);
        }
      }
      if (remote && tokenInHost(remote, id)) {
        errors.push(`input "${id}" picks the URL host, so it must be a choice, not a pattern`);
      }
    }
    if (input.default !== undefined) {
      const rule = { ...input, id } as unknown as IntegrationInput;
      if (typeof input.default !== "string" || inputValueError(rule, input.default)) {
        errors.push(`${at}.default must be a valid value for this input`);
      }
    }
  }
  for (const id of used) {
    if (!declared.has(id)) errors.push(`{${id}} is used but not declared in mcp.inputs`);
  }
  return errors;
}

/** Why a value is not acceptable for an input, or undefined when it is. */
export function inputValueError(input: IntegrationInput, value: string): string | undefined {
  if (!INPUT_VALUE_SAFE.test(value)) return `${input.label} may use letters, digits, dots, dashes and underscores only.`;
  if (input.choices) {
    return input.choices.some((choice) => choice.value === value) ? undefined : `${input.label} must be one of the listed options.`;
  }
  if (input.pattern) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(input.pattern);
    } catch {
      return `${input.label} cannot be checked.`;
    }
    return pattern.test(value) ? undefined : `${input.label} does not look right.`;
  }
  return undefined;
}

/** Replace every `{id}` with its value; callers validate the values first. */
export function interpolateInputs(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(INPUT_TOKEN, (whole, id: string) => values[id] ?? whole);
}

/** Package runners whose first argument is a package to fetch and run. */
const PACKAGE_RUNNERS = new Set(["npx", "pnpm", "bunx", "yarn", "uvx", "pipx"]);

const EXACT_VERSION = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const executableName = (command: string): string => command.split(/[\\/]/).pop() ?? command;

/**
 * A local server downloads and runs someone else's package on the machine
 * Polyth runs on, so its version is part of the trust decision: `@latest` or a
 * missing tag means the next install can run different code than the one that
 * was reviewed. Every package runner must name an exact version; a Docker
 * image must carry a tag or a digest, never `latest`.
 */
export function localPinningErrors(command: readonly string[]): string[] {
  const [binary, ...rest] = command;
  if (!binary) return [];
  const runner = executableName(binary);

  if (runner === "docker") {
    // The image is the first positional argument after the subcommand, not the
    // subcommand itself.
    const subcommand = rest.findIndex((part) => ["run", "exec", "create", "pull"].includes(part));
    if (subcommand === -1) return [];
    const image = rest.slice(subcommand + 1).find((part) => !part.startsWith("-"));
    if (!image) return [];
    if (image.includes("@sha256:")) return [];
    const tag = image.includes(":") ? image.slice(image.lastIndexOf(":") + 1) : "";
    if (!tag || tag === "latest") {
      return [`local command image "${image}" must pin a tag other than latest, or a digest`];
    }
    return [];
  }

  if (!PACKAGE_RUNNERS.has(runner)) return [];
  const positional = rest.filter((part) => !part.startsWith("-"));
  const spec = runner === "pnpm" || runner === "yarn"
    ? (positional[0] === "dlx" ? positional[1] : undefined)
    : positional[0];
  if (!spec) return [`local command "${runner}" must name a package, not only flags`];
  if (!EXACT_VERSION.test(spec)) {
    return [`local package "${spec}" must pin an exact version (name@1.2.3), not a range or a tag`];
  }
  return [];
}

function validateSkills(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4) return ["skills must be an array of at most 4 skills"];
  const errors: string[] = [];
  for (const [index, skill] of value.entries()) {
    const at = `skills[${index}]`;
    if (!isObject(skill)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    if (typeof skill.source !== "string" || !skill.source.trim() || skill.source.length > 200) {
      errors.push(`${at}.source must be a git source such as "owner/repo"`);
    }
    if (!isSafePath(skill.subpath)) errors.push(`${at}.subpath must be a repo-relative path`);
    if (typeof skill.name !== "string" || !ID_PATTERN.test(skill.name) || skill.name.length > 64) {
      errors.push(`${at}.name must be a kebab-case skill name`);
    }
  }
  return errors;
}

function validateEvidence(value: unknown): string[] {
  if (!isObject(value)) return ["evidence must be an object"];
  const errors: string[] = [];
  if (typeof value.checkedAt !== "string" || !ISO_DATE.test(value.checkedAt)
    || Number.isNaN(Date.parse(`${value.checkedAt}T00:00:00Z`))) {
    errors.push("evidence.checkedAt must be an ISO date (YYYY-MM-DD)");
  }
  if (!isHttpsUrl(value.source)) errors.push("evidence.source must be an https URL");
  if (!isObject(value.probe)) {
    errors.push("evidence.probe must be an object");
    return errors;
  }
  const probe = value.probe;
  if (probe.state !== "observed" && probe.state !== "documented" && probe.state !== "pending") {
    errors.push("evidence.probe.state must be observed, documented or pending");
  }
  if (probe.httpStatus !== undefined
    && (typeof probe.httpStatus !== "number" || !Number.isInteger(probe.httpStatus)
      || probe.httpStatus < 100 || probe.httpStatus > 599)) {
    errors.push("evidence.probe.httpStatus must be an HTTP status code");
  }
  if (probe.challenge !== undefined
    && !["bearer-oauth", "bearer", "none", "unknown"].includes(String(probe.challenge))) {
    errors.push("evidence.probe.challenge must be bearer-oauth, bearer, none or unknown");
  }
  if (probe.registration !== undefined
    && !["dynamic", "metadata-document", "none"].includes(String(probe.registration))) {
    errors.push("evidence.probe.registration must be dynamic, metadata-document or none");
  }
  if (probe.note !== undefined && (typeof probe.note !== "string" || probe.note.length > 600)) {
    errors.push("evidence.probe.note must be a string up to 600 characters");
  }
  if (probe.state === "observed" && probe.httpStatus === undefined) {
    errors.push("an observed probe records the httpStatus it saw");
  }
  return errors;
}

/** Duplicate ids are the one defect a single manifest cannot see. */
export function validateCatalog(manifests: readonly IntegrationManifest[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const manifest of manifests) {
    if (seen.has(manifest.id)) errors.push(`duplicate entry id "${manifest.id}"`);
    seen.add(manifest.id);
  }
  return errors;
}
