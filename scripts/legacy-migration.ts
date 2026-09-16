#!/usr/bin/env node
import {
  applyLegacyIdentityMigration,
  applyLegacyResourceAdoptions,
  inventoryLegacyMigration,
  stageLegacyMigration,
  verifyMigrationStage,
} from "../packages/tenancy/src/index.ts";

const args = process.argv.slice(2);
const command = args.shift();
const value = (name: string): string | undefined => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const result = args[at + 1];
  if (!result || result.startsWith("--")) throw Object.assign(new Error(`${name} requires a value`), { code: "invalid-input" });
  return result;
};
const required = (name: string): string => {
  const result = value(name);
  if (!result) throw Object.assign(new Error(`${name} is required`), { code: "invalid-input" });
  return result;
};
const print = (result: unknown): void => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function usage(): never {
  process.stderr.write([
    "Usage:",
    "  npm run migration:legacy -- inventory --data <dir>",
    "  npm run migration:legacy -- stage --data <dir> --stage <dir> --inventory-digest <sha256>",
    "  npm run migration:legacy -- verify --stage <dir> --manifest-digest <sha256>",
    "  npm run migration:legacy -- adopt --data <dir> --stage <dir> --manifest-digest <sha256>",
    "  npm run migration:legacy -- apply --data <dir> --stage <dir> --manifest-digest <sha256>",
    "",
    "Run stage/adopt/apply with Polyth stopped. Digests are deliberate operator acknowledgements.",
    "After adopt, run inventory + stage again and apply the new capsule.",
  ].join("\n"));
  process.exit(2);
}

try {
  if (command === "inventory") {
    const result = inventoryLegacyMigration({ dataDir: required("--data") });
    print({
      schemaVersion: result.schemaVersion,
      sourceRoot: result.sourceRoot,
      safeToStage: result.safeToStage,
      inventoryDigest: result.inventoryDigest,
      sources: result.sources.map(({ kind, present, sha256, bytes, counts }) => ({ kind, present, sha256, bytes, counts })),
      ownershipProofs: result.ownership.length,
      plannedAdoptions: result.plannedAdoptions,
      issues: result.issues,
    });
  } else if (command === "stage") {
    const result = stageLegacyMigration({
      dataDir: required("--data"),
      stageDir: required("--stage"),
      expectedInventoryDigest: required("--inventory-digest"),
    });
    print({
      migrationId: result.id,
      status: result.status,
      inventoryDigest: result.inventory.inventoryDigest,
      manifestDigest: result.manifestDigest,
      artifacts: result.artifacts.map(({ kind, status, bytes, sha256 }) => ({ kind, status, bytes, sha256 })),
      issues: result.inventory.issues,
      plannedAdoptions: result.inventory.plannedAdoptions,
    });
  } else if (command === "verify") {
    const result = verifyMigrationStage(required("--stage"), required("--manifest-digest"));
    print({
      migrationId: result.id,
      status: result.status,
      inventoryDigest: result.inventory.inventoryDigest,
      manifestDigest: result.manifestDigest,
      plannedAdoptions: result.inventory.plannedAdoptions,
      issues: result.inventory.issues,
    });
  } else if (command === "adopt") {
    print(applyLegacyResourceAdoptions({
      dataDir: required("--data"),
      stageDir: required("--stage"),
      expectedManifestDigest: required("--manifest-digest"),
    }));
  } else if (command === "apply") {
    print(applyLegacyIdentityMigration({
      dataDir: required("--data"),
      stageDir: required("--stage"),
      expectedManifestDigest: required("--manifest-digest"),
    }));
  } else {
    usage();
  }
} catch (error) {
  const code = (error as { code?: unknown } | null)?.code;
  process.stderr.write(`${typeof code === "string" ? code : "migration-failed"}\n`);
  process.exit(1);
}
