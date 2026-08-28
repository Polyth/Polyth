import { boot } from "@polyth/server";

const port = Number(process.env.PHASE8_POLYTH_PORT);
const dataDir = process.env.PHASE8_POLYTH_DATA;
if (!Number.isInteger(port) || port <= 0 || port === 14500 || !dataDir) {
  throw new Error("PHASE8_POLYTH_PORT (not 14500) and PHASE8_POLYTH_DATA are required");
}

const app = await boot({ port, hostname: "127.0.0.1", dataDir });
console.log(JSON.stringify({ type: "ready", pid: process.pid, port, dataDir }));

const shutdown = async (): Promise<void> => {
  await app.shutdown();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
