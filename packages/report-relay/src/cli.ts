import { createReportRelay } from "./index.ts";
import { startReportRelayHttpServer } from "./http.ts";
import { hashPassword } from "./password.ts";
import { DEFAULT_DAY_CAP, mint, parseTokens, tokenMap } from "./tokens.ts";
import { ReportStats } from "./stats.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `polyth-report-relay hash-password` reads the tester password from stdin —
// never from argv, where the shell would expose it — and prints the one-line
// scrypt record for <keysDir>/password.scrypt.
//
// `token` mints one group token: the secret half goes to stderr (shown once),
// the `tokens.json` entry with only its hash goes to stdout, so the two can be
// captured separately. `list-tokens` and `stats` read-only inspect a keys or
// data directory.
const command = process.argv[2] ?? "serve";
const argv = process.argv.slice(3);

if (command === "hash-password") {
  const password = await readPassword();
  if (!password) throw new Error("password must not be empty");
  process.stdout.write(`${hashPassword(password)}\n`);
} else if (command === "token") {
  mintToken();
} else if (command === "list-tokens") {
  listTokens();
} else if (command === "stats") {
  printStats();
} else if (command === "serve") {
  await serve();
} else {
  throw new Error(`unknown command: ${command} (serve, hash-password, token, list-tokens, stats)`);
}

function keysDirFrom(values: Record<string, string | true>): string {
  return typeof values.keys === "string" ? values.keys : process.env.REPORT_RELAY_KEYS_DIR ?? "/keys";
}

function dataDirFrom(values: Record<string, string | true>): string {
  return typeof values.data === "string" ? values.data : process.env.REPORT_RELAY_DATA_DIR ?? "/data";
}

/** `--name value` and `--name` pairs; an unknown or repeated name is refused
 *  rather than ignored, so a typo cannot mint a token with a default group. */
function flags(values: readonly string[], known: readonly string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (!value.startsWith("--")) throw new Error(`unexpected argument: ${value}`);
    const name = value.slice(2);
    if (!known.includes(name)) throw new Error(`unknown option: --${name}`);
    if (out[name] !== undefined) throw new Error(`repeated option: --${name}`);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) out[name] = true;
    else { out[name] = next; index++; }
  }
  return out;
}

function mintToken(): void {
  const values = flags(argv, ["group", "id", "label", "day-cap"]);
  const group = values.group;
  if (typeof group !== "string") throw new Error("token requires --group <slug>");
  const keyId = typeof values.id === "string" ? values.id : group;
  const label = typeof values.label === "string" && values.label.trim() ? values.label.trim() : group;
  const dayCap = values["day-cap"] === undefined ? DEFAULT_DAY_CAP : Number(values["day-cap"]);
  if (!Number.isInteger(dayCap) || dayCap < 1 || dayCap > 10_000) throw new Error("--day-cap must be 1-10000");

  const token = mint(keyId);
  const entry = { keyId: token.keyId, group, label, hash: token.hash, dayCap, disabled: false };
  // The hash-only entry is the file content; the secret never touches stdout.
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  process.stderr.write(`Token (shown once, give it to the testers of ${group}):\n${token.secret}\n`);
}

function listTokens(): void {
  const values = flags(argv, ["keys"]);
  const dir = keysDirFrom(values);
  let records;
  try {
    records = parseTokens(readFileSync(join(dir, "tokens.json"), "utf8"));
  } catch {
    throw new Error(`no readable tokens.json in ${dir}`);
  }
  const tokens = tokenMap(records);
  if (tokens.size === 0) {
    process.stdout.write("No group tokens: only the legacy tester password authenticates.\n");
    return;
  }
  for (const record of tokens.values()) {
    const status = record.disabled ? "disabled" : "active";
    process.stdout.write(`${record.keyId}\t${record.group}\t${record.dayCap}\t${status}\t${record.label}\n`);
  }
}

function printStats(): void {
  const values = flags(argv, ["data", "days"]);
  const dir = dataDirFrom(values);
  const days = values.days === undefined ? 7 : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new Error("--days must be 1-14");
  const stats = new ReportStats(join(dir, "stats.json"), Date.now);
  process.stdout.write(stats.render(Date.now(), days).markdown);
}

async function serve(): Promise<void> {
  const relay = createReportRelay({
    keysDir: process.env.REPORT_RELAY_KEYS_DIR ?? "/keys",
    dataDir: process.env.REPORT_RELAY_DATA_DIR ?? "/data",
    off: process.env.REPORT_RELAY_OFF === "1",
    logger: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
  });
  const host = process.env.REPORT_RELAY_HOST ?? "127.0.0.1";
  const port = portFrom(process.env.REPORT_RELAY_PORT ?? "8788");
  const server = await startReportRelayHttpServer(relay, {
    host,
    port,
    testMode: process.env.REPORT_RELAY_TEST_MODE === "1",
    tlsTerminated: process.env.REPORT_RELAY_TLS_TERMINATED === "1",
    ...(process.env.REPORT_RELAY_TRUSTED_PROXY ? { trustedProxy: process.env.REPORT_RELAY_TRUSTED_PROXY } : {}),
  });
  process.stderr.write(`${JSON.stringify({ listening: `${host}:${port}`, github: relay.health().github })}\n`);

  const shutdown = () => server.close(() => relay.close());
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function portFrom(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("REPORT_RELAY_PORT must be a valid TCP port");
  return port;
}

/** Reads stdin with terminal echo off, so the password never appears on screen
 *  and never enters shell history or an argument list. */
async function readPassword(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = "";
    stdin.setEncoding("utf8");
    for await (const chunk of stdin) text += chunk;
    return text.replace(/\r?\n$/, "");
  }
  process.stderr.write("Password: ");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return await new Promise<string>((resolve) => {
    let text = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") { cleanup(); process.stderr.write("\n"); resolve(text); return; }
        if (character === "\u0003") { cleanup(); process.stderr.write("\n"); process.exit(130); }
        if (character === "\u007f" || character === "\b") { text = text.slice(0, -1); continue; }
        if (text.length < 200 && character >= " ") text += character;
      }
    };
    stdin.on("data", onData);
  });
}
