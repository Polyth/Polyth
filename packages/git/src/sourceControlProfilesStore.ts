import { execFile } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
import {
  SOURCE_CONTROL_AUTH_MODES,
  SYSTEM_SOURCE_CONTROL_PROFILE_ID,
  parseSourceControlHostingAccountRef,
  sourceControlProfileMatchesRemote,
  type SourceControlCommitIdentity,
  type SourceControlProfile,
  type SourceControlProfileState,
} from "@polyth/contracts/source-control";
import { atomicWriteSync } from "@polyth/plugins";
import { resolveExecutable } from "@polyth/kernel/executable";
import { resolveGitBinary } from "./gitBinary.ts";

const bad = (message: string) => Object.assign(new Error(message), { code: "invalid-input" });
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, 256) : undefined;
const identity = (value: unknown): SourceControlCommitIdentity | null => {
  const row = (value ?? {}) as Partial<SourceControlCommitIdentity>;
  const name = text(row.name), email = text(row.email);
  return name && email ? { name, email } : null;
};

/** Absolute, shell-safe path of a private key inside realpath(home/.ssh); symlink escape rejected. */
export function validateIdentityFile(path: unknown, home = homedir()): string {
  if (typeof path !== "string" || path.length > 512 || !isAbsolute(path) || path.startsWith("-")
    || !/^[\w@%+=:,./~-]+$/.test(path) || path.endsWith(".pub")) throw bad("Invalid SSH key path");
  try {
    const real = realpathSync(path);
    if (!real.startsWith(realpathSync(join(home, ".ssh")) + sep) || basename(real).endsWith(".pub") || !statSync(real).isFile()) throw 0;
  } catch { throw bad("SSH key must be a private key file inside ~/.ssh"); }
  return path;
}

/** Absolute, shell-safe path of an SSH public key inside realpath(home/.ssh), for commit signing. */
export function validateSigningKey(path: unknown, home = homedir()): string {
  if (typeof path !== "string" || path.length > 512 || !isAbsolute(path) || path.startsWith("-")
    || !/^[\w@%+=:,./~-]+$/.test(path)) throw bad("Invalid signing key path");
  try {
    if (!path.endsWith(".pub")) throw 0;
    const real = realpathSync(path);
    if (!real.startsWith(realpathSync(join(home, ".ssh")) + sep) || !statSync(real).isFile()) throw 0;
  } catch { throw bad("Signing key must be a public key file (.pub) inside ~/.ssh"); }
  return path;
}

/** strict=false on read: a key deleted later must not make the stored state unreadable;
 * applying it still re-validates at /api/git/identity. */
export function normalizeProfileState(input: unknown, home = homedir(), strict = true): SourceControlProfileState {
  const raw = (input ?? {}) as Partial<SourceControlProfileState>;
  if (Array.isArray(raw.profiles) && raw.profiles.length > 50) throw bad("At most 50 profiles");
  const profiles = (Array.isArray(raw.profiles) ? raw.profiles : []).flatMap((value): SourceControlProfile[] => {
    const row = (value ?? {}) as Partial<SourceControlProfile>;
    const id = text(row.id), label = text(row.label);
    if (!id || !label) return [];
    const auth = (row.authentication ?? {}) as Partial<SourceControlProfile["authentication"]>;
    const hostingAccount = parseSourceControlHostingAccountRef(row.hostingAccount);
    const declared = SOURCE_CONTROL_AUTH_MODES.find((m) => m === auth.mode) ?? "system-git";
    // Account sign-in without an account is no sign-in at all: System Git.
    const mode = declared === "account" && !hostingAccount ? "system-git" : declared;
    const author = identity(row.commitAuthor);
    const signingKey = row.signingKey ? (strict ? validateSigningKey(row.signingKey, home) : String(row.signingKey).slice(0, 512)) : undefined;
    const meta = Object.entries(row.metadata ?? {}).flatMap(([k, v]) => text(k) && text(v) ? [[text(k)!, text(v)!]] : []).slice(0, 20);
    return [{
      id, label,
      provider: row.provider === "github" || row.provider === "gitlab" ? row.provider : "generic",
      ...(text(row.host) ? { host: text(row.host) } : {}),
      ...(text(row.account) ? { account: text(row.account) } : {}),
      ...(text(row.username) ? { username: text(row.username) } : {}),
      ...(author ? { commitAuthor: author } : {}),
      authentication: {
        mode,
        ...(text(auth.credentialRef) ? { credentialRef: text(auth.credentialRef) } : {}),
        ...(text(auth.accountRef) ? { accountRef: text(auth.accountRef) } : {}),
        ...(mode === "ssh-key" && auth.identityFile ? { identityFile: strict ? validateIdentityFile(auth.identityFile, home) : String(auth.identityFile).slice(0, 512) } : {}),
      },
      ...(signingKey ? { signingKey } : {}),
      ...(hostingAccount ? { hostingAccount } : {}),
      ...(meta.length ? { metadata: Object.fromEntries(meta) } : {}),
    }];
  });
  const known = (id: unknown): id is string => typeof id === "string" && (id === SYSTEM_SOURCE_CONTROL_PROFILE_ID || profiles.some((p) => p.id === id));
  return {
    profiles,
    globalDefaultProfileId: known(raw.globalDefaultProfileId) ? raw.globalDefaultProfileId : null,
    repositoryProfileIds: Object.fromEntries(Object.entries(raw.repositoryProfileIds ?? {}).filter(([k, v]) => text(k) && known(v))),
    repositorySystemIdentities: Object.fromEntries(Object.entries(raw.repositorySystemIdentities ?? {}).flatMap(([k, v]) => { const i = identity(v); return text(k) && i ? [[k, i]] : []; })),
  };
}

/** The validated private key of an SSH-key profile that applies to `hostname`. */
export function profileSshKey(state: SourceControlProfileState, profileId: unknown, hostname: string, home = homedir()): { profile: SourceControlProfile; identityFile: string } {
  const profile = state.profiles.find((row) => row.id === profileId);
  if (!profile) throw Object.assign(new Error("source-control identity not found"), { code: "not-found", status: 404 });
  if (profile.authentication.mode !== "ssh-key" || !profile.authentication.identityFile) {
    throw bad(`${profile.label} has no SSH key to sign in with`);
  }
  if (!sourceControlProfileMatchesRemote(profile, { url: "", hostname, fullPath: "", protocol: "ssh" })) {
    throw Object.assign(new Error(`${profile.label} belongs to another host`), { code: "account-not-applicable", status: 400 });
  }
  return { profile, identityFile: validateIdentityFile(profile.authentication.identityFile, home) };
}

export function createSourceControlProfilesStore(storageFor: (space: SpaceContext) => SpaceStorage, home = homedir()) {
  const file = (space: SpaceContext) => `${storageFor(space).packageDir("git")}/source-control-profiles.json`;
  const read = (space: SpaceContext): { state: SourceControlProfileState; revision: number } => {
    try {
      const value = JSON.parse(readFileSync(file(space), "utf8"));
      if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Invalid profiles revision");
      return { state: normalizeProfileState(value.state, home, false), revision: value.revision };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { state: normalizeProfileState({}, home), revision: 0 };
      throw cause;
    }
  };
  return { read, save(space: SpaceContext, input: unknown, expectedRevision: number) {
    const state = normalizeProfileState(input, home);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw bad("Invalid revision");
    const current = read(space);
    if (current.revision !== expectedRevision) throw Object.assign(new Error("Source-control profiles changed elsewhere. Reload."), { code: "conflict" });
    atomicWriteSync(file(space), JSON.stringify({ state, revision: current.revision + 1, updatedAt: Date.now() }), 0o600);
    return { state, revision: current.revision + 1 };
  } };
}

const SSH_COMMAND = /^ssh -i ([\w@%+=:,./~-]+) -o IdentitiesOnly=yes$/;
const git = (root: string, args: string[]) => new Promise<{ code: number; stdout: string }>((done) =>
  execFile(resolveGitBinary(), ["-C", root, ...args], { timeout: 10_000 }, (err, stdout) => done({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout) })));

export async function getSshKey(root: string): Promise<string | null> {
  const r = await git(root, ["config", "--local", "--get", "core.sshCommand"]);
  return r.code === 0 ? SSH_COMMAND.exec(r.stdout.trim())?.[1] ?? null : null;
}

/** string → set (validated); null → unset only a Polyth-format value; undefined → untouched. */
export async function applySshKey(root: string, sshKey: string | null | undefined, home = homedir()): Promise<void> {
  if (sshKey === undefined) return;
  if (sshKey === null) {
    const r = await git(root, ["config", "--local", "--get", "core.sshCommand"]);
    if (r.code === 0 && SSH_COMMAND.test(r.stdout.trim())) await git(root, ["config", "--local", "--unset", "core.sshCommand"]);
    return;
  }
  const path = validateIdentityFile(sshKey, home);
  const r = await git(root, ["config", "--local", "core.sshCommand", `ssh -i ${path} -o IdentitiesOnly=yes`]);
  if (r.code !== 0) throw new Error("git config core.sshCommand failed");
}

// Polyth marks the config it writes so switching identities never removes a
// signing or credential setup the person made by hand.
const SIGNING_MARKER = "polyth.managedsigning";
const ANONYMOUS_MARKER = "polyth.anonymous";
/** No keys, no agent, no ~/.ssh/config: an SSH remote cannot sign in at all. */
export const ANONYMOUS_SSH_COMMAND = "ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes";
const localConfig = async (root: string, key: string): Promise<string | null> => {
  const r = await git(root, ["config", "--local", "--get", key]);
  return r.code === 0 ? r.stdout.trim() : null;
};

/** The SSH public key this checkout signs commits with, when Polyth set it up. */
export async function getSigningKey(root: string): Promise<string | null> {
  if (await localConfig(root, SIGNING_MARKER) !== "true") return null;
  return await localConfig(root, "user.signingkey");
}

/** string → sign every commit with that SSH key (validated); null → undo only
 *  Polyth's own signing setup; undefined → untouched. */
export async function applySigningKey(root: string, signingKey: string | null | undefined, home = homedir()): Promise<void> {
  if (signingKey === undefined) return;
  if (signingKey === null) {
    if (await localConfig(root, SIGNING_MARKER) !== "true") return;
    for (const key of ["user.signingkey", "gpg.format", "commit.gpgsign", "tag.gpgsign", SIGNING_MARKER]) {
      await git(root, ["config", "--local", "--unset-all", key]);
    }
    return;
  }
  const path = validateSigningKey(signingKey, home);
  for (const [key, value] of [["gpg.format", "ssh"], ["user.signingkey", path], ["commit.gpgsign", "true"], ["tag.gpgsign", "true"], [SIGNING_MARKER, "true"]] as const) {
    const r = await git(root, ["config", "--local", key, value]);
    if (r.code !== 0) throw new Error(`git config ${key} failed`);
  }
}

/** Whether Polyth made this checkout anonymous (no host credentials). */
export async function getAnonymous(root: string): Promise<boolean> {
  return await localConfig(root, ANONYMOUS_MARKER) === "true";
}

/** true → hide the host's credential helpers and SSH keys from this checkout;
 *  false → undo only Polyth's own anonymous setup; undefined → untouched. */
export async function applyAnonymous(root: string, anonymous: boolean | undefined): Promise<void> {
  if (anonymous === undefined) return;
  if (!anonymous) {
    if (!(await getAnonymous(root))) return;
    if (await localConfig(root, "core.sshCommand") === ANONYMOUS_SSH_COMMAND) await git(root, ["config", "--local", "--unset", "core.sshCommand"]);
    await git(root, ["config", "--local", "--unset-all", "credential.helper"]);
    await git(root, ["config", "--local", "--unset-all", ANONYMOUS_MARKER]);
    return;
  }
  // An empty helper resets every helper collected from the host's config files.
  for (const [key, value] of [["credential.helper", ""], ["core.sshCommand", ANONYMOUS_SSH_COMMAND], [ANONYMOUS_MARKER, "true"]] as const) {
    const r = await git(root, ["config", "--local", "--replace-all", key, value]);
    if (r.code !== 0) throw new Error(`git config ${key} failed`);
  }
}

export function listSshKeys(home = homedir()): Array<{ path: string; name: string; comment?: string }> {
  const dir = join(home, ".ssh");
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const names = new Set(entries.map((e) => e.name));
  return entries.filter((e) => e.isFile() && !e.name.endsWith(".pub") && names.has(`${e.name}.pub`)).sort((a, b) => a.name.localeCompare(b.name)).map((e) => {
    let comment: string | undefined;
    try { comment = readFileSync(join(dir, `${e.name}.pub`), "utf8").trim().split(/\s+/).slice(2).pop(); } catch { /* unreadable pub */ }
    return { path: join(dir, e.name), name: e.name, ...(comment ? { comment } : {}) };
  });
}

/** `-F /dev/null`: a `~/.ssh/config` IdentityFile for the host is tried after `-i` even with
 *  IdentitiesOnly, so a key that cannot sign would silently "connect" as another account. */
export const sshTestArgs = (key: string, host: string): string[] => ["-T", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
  "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8", "-i", key, `git@${host}`];

export const SSH_KEY_PASSPHRASE_MESSAGE = "This key is passphrase-protected and is not loaded in an ssh-agent available to Polyth, so Git cannot use it unattended. Run ssh-add for it on the Polyth host, or choose a key without a passphrase.";

export function testSshKey(path: unknown, host: unknown = "github.com", home = homedir()): Promise<{ ok: boolean; account?: string; message: string }> {
  const key = validateIdentityFile(path, home);
  if (typeof host !== "string" || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host)) throw bad("Invalid host");
  return new Promise((done) => execFile(resolveExecutable("ssh"), sshTestArgs(key, host), { timeout: 12_000 }, (err, stdout, stderr) => {
    const message = `${stdout}${stderr}`.trim().slice(0, 300);
    const account = /Hi ([\w.-]+)!/.exec(message)?.[1] ?? /Welcome to GitLab, @([\w.-]+)!/.exec(message)?.[1];
    if (account || !err) { done({ ok: true, ...(account ? { account } : {}), message: message || "Connected" }); return; }
    execFile(resolveExecutable("ssh-keygen"), ["-y", "-P", "", "-f", key], { timeout: 5_000 }, (_keyErr, _out, keyStderr) => done({
      ok: false,
      message: /passphrase/i.test(String(keyStderr)) ? SSH_KEY_PASSPHRASE_MESSAGE : message || err.message,
    }));
  }));
}
