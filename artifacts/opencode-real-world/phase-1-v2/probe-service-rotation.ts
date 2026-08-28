import { writeFile } from "node:fs/promises";
import {
  createBorrowedServiceEndpointLease,
} from "@polyth/backend-opencode";

const output = process.env.PROBE_OUTPUT
  ?? "logs/opencode-real-world/phase-1-v2/service-rotation.json";
const directory = "/tmp/polyth-oc-phase1-v2/project";
const authA = process.env.PROBE_AUTH_A;
const authB = process.env.PROBE_AUTH_B;
if (!authA || !authB) {
  throw new Error("PROBE_AUTH_A and PROBE_AUTH_B are required");
}

const descriptors = [
  {
    url: "http://127.0.0.1:45127",
    authorityId: "injected-test-service",
    continuity: "verified" as const,
    instanceId: "real-opencode-auth-a",
    headers: {
      Authorization: `Basic ${Buffer.from(authA).toString("base64")}`,
    },
  },
  {
    url: "http://127.0.0.1:45128",
    authorityId: "injected-test-service",
    continuity: "verified" as const,
    instanceId: "real-opencode-auth-b",
    headers: {
      Authorization: `Basic ${Buffer.from(authB).toString("base64")}`,
    },
  },
];
let descriptorIndex = 0;

const lease = await createBorrowedServiceEndpointLease({
  location: { directory },
  discover: async () => descriptors[descriptorIndex],
  ensure: async () => descriptors[descriptorIndex]!,
});

const probe = async (
  url: string,
  headers: Readonly<Record<string, string>>,
) => {
  const response = await fetch(`${url}/api/health`, { headers });
  return {
    status: response.status,
    body: await response.text(),
  };
};

const first = await lease.endpoint();
const firstHeaders = await first.authentication.resolve();
const firstResponse = await probe(first.url, firstHeaders);

descriptorIndex = 1;
const second = await lease.refresh();
const secondHeaders = await second.authentication.resolve();
const secondResponse = await probe(second.url, secondHeaders);
const staleHeadersAgainstReplacement = await probe(second.url, firstHeaders);

await lease.dispose();

const result = {
  capturedAt: new Date().toISOString(),
  limitation:
    "Descriptors are injected through Polyth's library seam because OpenCode 1.18.18 exposes no Service.discover/ensure API.",
  first: {
    url: first.url,
    authorityId: first.authorityId,
    continuity: first.continuity,
    generation: first.generation,
    control: first.control,
    config: first.config,
    headerNames: Object.keys(firstHeaders),
    headers: { authorization: "[REDACTED]" },
    response: firstResponse,
  },
  replacement: {
    url: second.url,
    authorityId: second.authorityId,
    continuity: second.continuity,
    generation: second.generation,
    control: second.control,
    config: second.config,
    headerNames: Object.keys(secondHeaders),
    headers: { authorization: "[REDACTED]" },
    response: secondResponse,
  },
  staleHeadersAgainstReplacement,
};

await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
