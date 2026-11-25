#!/usr/bin/env node
// Explicit local operator recovery. This file is intentionally not imported by
// the HTTP server or web application. Password material is never accepted in
// argv, printed, or included in error messages.
import "./check-node.mjs";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openControlPlane, readLegacyJson } from "../packages/control-plane/src/index.ts";
import { createIdentityService } from "../packages/identity/src/index.ts";
import { loginName } from "../packages/identity/src/validation.ts";
import { acquireDataDirectoryLease } from "../packages/server/src/indexCore.ts";

const help = `Polyth local account break-glass recovery

Reset a password step by step (asks for everything, on a terminal):
  npm run auth:break-glass -- --data-dir DIR

Inspect the installation confirmation value and the local logins (read-only):
  npm run auth:break-glass -- inspect --data-dir DIR

Reset one local account password while Polyth is offline:
  npm run auth:break-glass -- reset --data-dir DIR --login LOGIN \\
    --installation INSTALLATION_ID --reason "why operator recovery is required" --offline

Security contract:
- reset requires the canonical writer lease; a running Polyth server blocks it;
- --offline is an explicit acknowledgement, not a replacement for the lock;
- the installation ID must exactly match this data directory;
- the new password is read from hidden TTY input, or one line from stdin;
- the step-by-step reset runs only on a terminal and asks for the login and a
  typed RESET instead of the --installation, --reason and --offline flags;
- password values are never accepted on the command line or printed;
- the identity service revokes every old session and writes the audit event.

For non-interactive use, pipe exactly one password line from a trusted secret
source. Do not put the password directly in shell history.
`;

type Sentinel = { version?: unknown; id?: unknown };

const fail = (code: string): Error => Object.assign(new Error(code), { code });

function installationId(dataDir: string): string {
  const record = readLegacyJson(join(dataDir, "control-plane", "installation.json"));
  const value = record?.value as Sentinel | undefined;
  if (!value || value.version !== 1 || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)) {
    throw fail("installation-not-found");
  }
  return value.id;
}

function onePipedPassword(): string {
  const raw = readFileSync(0, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 2_048 || raw.includes("\0")) throw fail("invalid-secret-input");
  const value = raw.replace(/\r?\n$/, "");
  if (/[\r\n]/.test(value)) throw fail("invalid-secret-input");
  return value;
}

async function hiddenLine(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") throw fail("tty-unavailable");
  process.stderr.write(prompt);
  return new Promise<string>((resolveLine, rejectLine) => {
    let value = "";
    const finish = (error?: Error): void => {
      input.off("data", onData);
      try { input.setRawMode(false); } catch { /* best effort */ }
      input.pause();
      process.stderr.write("\n");
      if (error) rejectLine(error);
      else resolveLine(value);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const char of String(chunk)) {
        if (char === "\u0003" || char === "\u0004") {
          finish(fail("cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        if (char < " " || char === "\u007f") continue;
        value += char;
        if (Buffer.byteLength(value, "utf8") > 1_024) {
          finish(fail("invalid-secret-input"));
          return;
        }
      }
    };
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

/** A visible line from the terminal (a login or a typed confirmation). */
async function visibleLine(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await lines.question(prompt)).trim();
  } finally {
    lines.close();
  }
}

type LocalLogin = { login: string; name: string; owner: boolean; status: string };

/** Login names are not secrets: listing them read-only settles "which login
 *  is mine" without touching a running server. */
function localLogins(dataDir: string): LocalLogin[] {
  const file = join(dataDir, "control-plane", "control.sqlite");
  if (!existsSync(file)) throw fail("installation-not-found");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(
      `SELECT c.login_name AS login,u.display_name AS name,p.status AS status,
              EXISTS(SELECT 1 FROM instance_roles r WHERE r.user_id=c.user_id AND r.role='owner') AS owner
         FROM password_credentials c JOIN principals p ON p.id=c.user_id JOIN users u ON u.id=p.id
        WHERE p.kind='user' ORDER BY owner DESC, c.login_name`,
    ).all() as Array<{ login: string; name: string; status: string; owner: number }>)
      .map((row) => ({ login: row.login, name: row.name, owner: row.owner === 1, status: row.status }));
  } finally {
    db.close();
  }
}

async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) return onePipedPassword();
  const first = await hiddenLine("New password: ");
  const second = await hiddenLine("Repeat new password: ");
  if (first !== second) throw fail("passwords-do-not-match");
  return first;
}

let control: ReturnType<typeof openControlPlane> | undefined;
let identity: ReturnType<typeof createIdentityService> | undefined;
let lease: Awaited<ReturnType<typeof acquireDataDirectoryLease>> | undefined;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      login: { type: "string" },
      installation: { type: "string" },
      reason: { type: "string" },
      offline: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(help);
  } else {
    const guided = positionals.length === 0;
    const command = guided ? "reset" : positionals[0];
    if (positionals.length > 1 || !["inspect", "reset"].includes(command ?? "")) throw fail("usage");
    const dataDir = resolve(values["data-dir"]?.trim() || process.env.POLYTH_DATA_DIR || "./data");
    const actualInstallation = installationId(dataDir);

    if (command === "inspect") {
      if (values.login || values.installation || values.reason || values.offline) throw fail("usage");
      const accounts = localLogins(dataDir);
      process.stdout.write(`${JSON.stringify({ installationId: actualInstallation, dataDir, accounts }, null, 2)}\n`);
    } else {
      let loginInput: string, reasonInput: string;
      if (guided) {
        // A person at this computer's terminal: the typed answers replace the
        // operator flags, the writer lease still refuses a running Polyth.
        if (values.login || values.installation || values.reason || values.offline) throw fail("usage");
        if (!process.stdin.isTTY) throw fail("tty-unavailable");
        const accounts = localLogins(dataDir).filter((account) => account.status === "active");
        if (accounts.length === 0) throw fail("eligible-local-account-not-found");
        process.stderr.write(`Polyth data: ${dataDir}\nQuit Polyth before you continue.\n\nAccounts with a password:\n`);
        for (const account of accounts) process.stderr.write(`  ${account.login}${account.owner ? "  (owner)" : ""}  ${account.name}\n`);
        const fallback = accounts.find((account) => account.owner)?.login ?? accounts[0]!.login;
        loginInput = (await visibleLine(`\nLogin to reset [${fallback}]: `)) || fallback;
        if ((await visibleLine(`Type RESET to set a new password for "${loginInput}": `)) !== "RESET") throw fail("cancelled");
        reasonInput = "Password reset step by step on this computer";
      } else {
        if (values.offline !== true) throw fail("offline-required");
        if (typeof values.installation !== "string" || values.installation !== actualInstallation) {
          throw fail("installation-confirmation-mismatch");
        }
        if (typeof values.login !== "string" || typeof values.reason !== "string") throw fail("usage");
        loginInput = values.login;
        reasonInput = values.reason;
      }
      const login = loginName(loginInput);
      // Validate the reason before asking for a secret or opening the authority.
      const reason = reasonInput.trim();
      if (reason.length < 10 || reason.length > 500 || /[\x00-\x1f\x7f]/.test(reason)) throw fail("invalid-reason");
      // A running Polyth holds the writer lease: refuse before asking for a secret.
      lease = await acquireDataDirectoryLease(dataDir);
      const password = await readNewPassword();
      control = openControlPlane({ directory: lease.canonicalDataDir });
      if (control.installation().id !== actualInstallation || control.installation().state !== "ready") {
        throw fail("installation-not-ready");
      }
      const account = control.get<{ user_id: string }>(
        `SELECT c.user_id FROM password_credentials c
         JOIN principals p ON p.id=c.user_id JOIN users u ON u.id=p.id
         WHERE c.login_name=? AND p.kind='user'`,
        login,
      );
      if (!account) throw fail("eligible-local-account-not-found");

      identity = createIdentityService(control);
      await identity.credentials.operatorResetPassword({
        userId: account.user_id,
        password,
        installationId: actualInstallation,
        reason,
      });
      if (guided) process.stderr.write(`\nDone. Open Polyth and sign in as "${login}" with the new password.\n`);
      process.stdout.write(`${JSON.stringify({ ok: true, userId: account.user_id, installationId: actualInstallation })}\n`);
    }
  }
} catch (cause) {
  // Never echo Error.message: parser/IO errors can contain pasted arguments and
  // secret-provider details. Only a bounded internal code crosses this boundary.
  const candidate = (cause as NodeJS.ErrnoException | null)?.code;
  const code = typeof candidate === "string" && /^[a-z0-9-]{2,64}$/.test(candidate)
    ? candidate
    : "usage-or-recovery-failure";
  process.stderr.write(`${JSON.stringify({ error: code, hint: "Run with --help." })}\n`);
  process.exitCode = 1;
} finally {
  try { identity?.close(); } catch { /* preserve command result */ }
  try { control?.close(); } catch { /* preserve command result */ }
  try { await lease?.release(); } catch {
    if (!process.exitCode) process.exitCode = 1;
  }
}
