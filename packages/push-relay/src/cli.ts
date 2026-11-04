import { join } from "node:path";

import { apnsFromDir, fcmFromFile } from "./providers.ts";
import { createPushRelay } from "./index.ts";
import { startRelayHttpServer } from "./http.ts";

// The app's APNs key (`apns.json` + `apns.p8`, re-read on change) and, for
// Android, a Firebase service account (`fcm.json`, read at start).
const keys = process.env.PUSH_RELAY_KEYS_DIR ?? "/keys";
const ios = apnsFromDir(keys);
const fcm = fcmFromFile(join(keys, "fcm.json"));
const relay = createPushRelay({
  providers: { ios, android: () => fcm },
  logger: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
});

const host = process.env.PUSH_RELAY_HOST ?? "127.0.0.1";
const port = portFrom(process.env.PUSH_RELAY_PORT ?? "8787");
const server = await startRelayHttpServer(relay, {
  host,
  port,
  testMode: process.env.PUSH_RELAY_TEST_MODE === "1",
  tlsTerminated: process.env.PUSH_RELAY_TLS_TERMINATED === "1",
  ...(process.env.PUSH_RELAY_TRUSTED_PROXY ? { trustedProxy: process.env.PUSH_RELAY_TRUSTED_PROXY } : {}),
});
process.stderr.write(`${JSON.stringify({ listening: `${host}:${port}`, apns: Boolean(ios()), fcm: Boolean(fcm) })}\n`);

const shutdown = () => server.close(() => relay.close());
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function portFrom(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PUSH_RELAY_PORT must be a valid TCP port");
  return port;
}
