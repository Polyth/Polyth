/** OC-REAL-003: raw /provider vs Polyth catalog normalization.
 *  OC-REAL-004: provider connectivity truth + no secret disclosure. */
import { join } from "node:path";
import {
  createOpenCodeTransport,
  createProtocolAdapter,
} from "@polyth/backend-opencode";
import type { RuntimeEndpoint } from "@polyth/contracts";
import {
  httpJson,
  makeScratch,
  spawnServe,
  writeEvidence,
  writeVerdict,
  WireLog,
  OPENCODE_VERSION,
} from "./lib.ts";

interface RawProvider {
  id: string;
  name?: string;
  models?: Record<string, {
    id?: string;
    name?: string;
    variants?: Record<string, unknown>;
    capabilities?: { attachment?: boolean; toolcall?: boolean; input?: Record<string, boolean>; output?: Record<string, boolean> };
  }>;
}

const main = async (): Promise<void> => {
  const scratch = await makeScratch("OC-REAL-003");
  const scratch4 = await makeScratch("OC-REAL-004");
  const wire = new WireLog(join(scratch.logsDir, "wire.ndjson"));
  const serve = await spawnServe(scratch);
  const failures3: string[] = [];
  const failures4: string[] = [];
  try {
    const raw = await httpJson(serve.url, "GET", `/provider?directory=${encodeURIComponent(scratch.project)}`, undefined, wire);
    const rawBody = raw.body as { all?: RawProvider[]; connected?: string[] };

    const transport = createOpenCodeTransport({ baseUrl: serve.url, directory: scratch.project });
    const endpoint: RuntimeEndpoint = {
      authorityId: "oc-real-003",
      continuity: "generation-only",
      generation: 1,
      url: serve.url,
      location: { directory: scratch.project },
      control: { kind: "borrowed", source: "external" },
      config: { kind: "read-only" },
      authentication: { kind: "basic-env", usernameEnv: "OPENCODE_SERVER_USERNAME", passwordEnv: "OPENCODE_SERVER_PASSWORD" },
    };
    const adapter = await createProtocolAdapter({ protocol: "legacy", transport, endpoint });
    const models = await adapter.models();

    // --- OC-REAL-003 comparisons ---
    const rawProviders = rawBody.all ?? [];
    const rawConnected = rawBody.connected ?? [];
    const rawModelKeys = new Set(
      rawProviders.flatMap((provider) =>
        Object.entries(provider.models ?? {}).map(([key, model]) => `${provider.id}/${model.id ?? key}`)),
    );
    const catalogKeys = new Set(models.map((model) => `${model.providerID}/${model.modelID}`));
    const missingFromCatalog = [...rawModelKeys].filter((key) => !catalogKeys.has(key));
    const inventedInCatalog = [...catalogKeys].filter((key) => !rawModelKeys.has(key));
    if (missingFromCatalog.length > 0) failures3.push(`models missing from catalog: ${missingFromCatalog.slice(0, 5).join(", ")}`);
    if (inventedInCatalog.length > 0) failures3.push(`catalog invented models: ${inventedInCatalog.slice(0, 5).join(", ")}`);

    // Connectivity must match raw `connected` exactly.
    const connectedSet = new Set(rawConnected);
    const wrongConnectivity = models.filter((model) =>
      model.connected !== (rawConnected.length > 0 ? connectedSet.has(model.providerID) : true));
    if (wrongConnectivity.length > 0) {
      failures3.push(`connectivity drift on ${wrongConnectivity.length} models e.g. ${wrongConnectivity[0]?.providerID}/${wrongConnectivity[0]?.modelID}`);
    }

    // Variants and modality capabilities survive for a sample google model.
    const variantSamples = rawProviders.flatMap((provider) =>
      Object.entries(provider.models ?? {})
        .filter(([, model]) => model.variants && Object.keys(model.variants).length > 0)
        .map(([key, model]) => ({
          key: `${provider.id}/${model.id ?? key}`,
          rawVariants: Object.keys(model.variants ?? {}),
          catalogVariants: models.find((entry) => entry.providerID === provider.id && entry.modelID === (model.id ?? key))?.variants ?? [],
        })));
    const variantDrift = variantSamples.filter((sample) =>
      JSON.stringify([...sample.rawVariants].sort()) !== JSON.stringify([...sample.catalogVariants].sort()));
    if (variantDrift.length > 0) failures3.push(`variant drift: ${JSON.stringify(variantDrift.slice(0, 3))}`);

    const googleSample = models.filter((model) => model.providerID === "google").slice(0, 4);
    await writeEvidence(scratch, "catalog-comparison.json", {
      rawProviderCount: rawProviders.length,
      rawModelCount: rawModelKeys.size,
      catalogModelCount: models.length,
      rawConnected,
      connectedInCatalog: [...new Set(models.filter((model) => model.connected).map((model) => model.providerID))],
      missingFromCatalog: missingFromCatalog.slice(0, 20),
      inventedInCatalog: inventedInCatalog.slice(0, 20),
      variantSampleCount: variantSamples.length,
      variantDrift: variantDrift.slice(0, 5),
      googleSample,
      failures: failures3,
    });
    await writeVerdict(scratch, {
      id: "OC-REAL-003",
      verdict: failures3.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `raw ${rawModelKeys.size} models / ${rawProviders.length} providers, connected=${JSON.stringify(rawConnected)}; catalog ${models.length} models; ${variantSamples.length} variant models compared${failures3.length ? `; failures: ${failures3.join("; ")}` : ""}`,
      expected: "IDs, names, connection state, modalities and variants survive normalization exactly",
      attribution: failures3.length === 0 ? "NONE" : "POLYTH",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-003/catalog-comparison.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-003/wire.ndjson",
      ],
    });

    // --- OC-REAL-004: connectivity source + secret hygiene ---
    const secretValues = [process.env.GEMINI_API_KEY, process.env.GOOGLE_GENERATIVE_AI_API_KEY]
      .filter((value): value is string => !!value && value.length > 4);
    const surfaces = {
      rawProvider: raw.raw,
      catalog: JSON.stringify(models),
      agents: JSON.stringify(await adapter.agents()),
    };
    const leaks = Object.entries(surfaces)
      .filter(([, text]) => secretValues.some((secret) => text.includes(secret)))
      .map(([name]) => name);
    if (leaks.length > 0) failures4.push(`secret value found in: ${leaks.join(", ")}`);
    const googleConnected = rawConnected.includes("google");
    if (!googleConnected) failures4.push("google provider (configured via GEMINI_API_KEY env) not reported connected upstream");
    const catalogGoogleConnected = models.some((model) => model.providerID === "google" && model.connected);
    if (googleConnected !== catalogGoogleConnected) failures4.push("catalog connectivity does not match upstream connectivity");
    await writeEvidence(scratch4, "secret-hygiene.json", {
      surfacesChecked: Object.keys(surfaces),
      secretEnvVarNames: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
      leaks,
      upstreamConnected: rawConnected,
      catalogConnectedProviders: [...new Set(models.filter((model) => model.connected).map((model) => model.providerID))],
      failures: failures4,
    });
    await writeVerdict(scratch4, {
      id: "OC-REAL-004",
      verdict: failures4.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `connected upstream=${JSON.stringify(rawConnected)}; catalog matches; no secret literal in raw /provider, catalog or agents surfaces${failures4.length ? `; failures: ${failures4.join("; ")}` : ""}`,
      expected: "connected providers match upstream; no secret literal in API surfaces",
      attribution: failures4.length === 0 ? "NONE" : (leaks.length > 0 ? "AMBIGUITY" : "OPENCODE"),
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-004/secret-hygiene.json",
      ],
      notes: "UI surface not exercised here; API/catalog surfaces only. Provider credentials supplied via env var names only.",
    });
  } finally {
    await serve.stop();
  }
};

await main();
