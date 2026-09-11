import { ApnsProvider, FcmProvider, ServiceAccountAccessTokenProvider } from "./providers.ts";
import { createPushRelay, parseRelayMasterKey } from "./index.ts";
import { startRelayHttpServer } from "./http.ts";
import type { Platform, ProviderAdapter } from "./types.ts";

const databaseFile = required("PUSH_RELAY_DB");
const relay = createPushRelay({
  file: databaseFile,
  masterKey: parseRelayMasterKey(process.env.PUSH_RELAY_MASTER_KEY),
  providers: configuredProviders(),
  logger: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
});

const host = process.env.PUSH_RELAY_HOST ?? "127.0.0.1";
const port = portFrom(process.env.PUSH_RELAY_PORT ?? "8787");
const testMode = process.env.PUSH_RELAY_TEST_MODE === "1";
const tlsTerminated = process.env.PUSH_RELAY_TLS_TERMINATED === "1";
const server = await startRelayHttpServer(relay, { host, port, testMode, tlsTerminated });

const shutdown = () => server.close(() => relay.close());
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function configuredProviders() {
  const providers: Partial<Record<Platform, ProviderAdapter>> = {};
  const teamId = process.env.PUSH_RELAY_APNS_TEAM_ID;
  const keyId = process.env.PUSH_RELAY_APNS_KEY_ID;
  const p8 = process.env.PUSH_RELAY_APNS_P8;
  const topic = process.env.PUSH_RELAY_APNS_TOPIC;
  if (teamId || keyId || p8 || topic) {
    if (!teamId || !keyId || !p8 || !topic) throw new Error("incomplete APNs configuration");
    providers.ios = new ApnsProvider({ teamId, keyId, p8, topic });
  }
  const project = process.env.PUSH_RELAY_FCM_PROJECT;
  const serviceAccountJson = process.env.PUSH_RELAY_FCM_SERVICE_ACCOUNT_JSON;
  if (project || serviceAccountJson) {
    if (!project || !serviceAccountJson) throw new Error("incomplete FCM configuration");
    providers.android = new FcmProvider({ project, accessTokenProvider: new ServiceAccountAccessTokenProvider({ serviceAccountJson }) });
  }
  return providers;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function portFrom(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PUSH_RELAY_PORT must be a valid TCP port");
  return port;
}
