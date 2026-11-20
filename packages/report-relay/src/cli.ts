import { createReportRelay } from "./index.ts";
import { startReportRelayHttpServer } from "./http.ts";
import { hashPassword } from "./password.ts";

// `polyth-report-relay hash-password` reads the tester password from stdin —
// never from argv, where the shell would expose it — and prints the one-line
// scrypt record for <keysDir>/password.scrypt.
if (process.argv[2] === "hash-password") {
  const password = await readPassword();
  if (!password) throw new Error("password must not be empty");
  process.stdout.write(`${hashPassword(password)}\n`);
} else {
  await serve();
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
