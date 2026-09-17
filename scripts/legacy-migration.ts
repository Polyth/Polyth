#!/usr/bin/env node
// Explicit offline operator tool. Never invoked from server startup or auth UI.
import "./check-node.mjs";
import { parseArgs } from "node:util";
import {
  applyLegacyIdentityMigration,
  applyLegacyResourceAdoptions,
  inventoryLegacyMigration,
  stageLegacyMigration,
  verifyMigrationStage,
} from "../packages/tenancy/src/index.ts";

const help = `Polyth reviewed legacy migration

  npm run migration:legacy -- inventory --data DIR [--profile-owners-file FILE]
  npm run migration:legacy -- stage --data DIR --stage DIR --inventory-digest SHA256 --offline [--profile-owners-file FILE]
  npm run migration:legacy -- verify --stage DIR --manifest-digest SHA256
  npm run migration:legacy -- adopt --data DIR --stage DIR --manifest-digest SHA256 --offline [--profile-owners-file FILE]
  npm run migration:legacy -- apply --data DIR --stage DIR --manifest-digest SHA256 --offline [--profile-owners-file FILE]

Protocol:
  1. inventory: review source evidence, issues, ownership proofs, and planned adoptions.
  2. stage: while Polyth and every legacy writer are stopped, acknowledge the exact
     inventory digest and create a private immutable migration capsule.
  3. verify: independently verify the capsule using its recorded manifest digest.
  4. adopt: if resource adoptions are planned, apply only those reviewed ownership
     stamps, then repeat inventory + stage against the changed legacy state.
  5. apply: activate canonical identity/Spaces only from a verified capsule with no
     unresolved resource adoptions. Legacy browser sessions are intentionally revoked.

--offline is an explicit operator acknowledgement, not a process lock. The migration
engine also fingerprints live sources immediately before mutation and fails on drift.
Keep the stage directory private and record digests separately.
`;

type Command = "inventory" | "stage" | "verify" | "adopt" | "apply";
const commands = new Set<Command>(["inventory", "stage", "verify", "adopt", "apply"]);

const print = (value: unknown): void => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      data: { type: "string" },
      stage: { type: "string" },
      "inventory-digest": { type: "string" },
      "manifest-digest": { type: "string" },
      "profile-owners-file": { type: "string" },
      offline: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    process.stdout.write(help);
  } else {
    if (positionals.length !== 1 || !commands.has(positionals[0] as Command)) fail("usage");
    const command = positionals[0] as Command;
    const allowed: Record<Command, Set<string>> = {
      inventory: new Set(["data", "profile-owners-file"]),
      stage: new Set(["data", "stage", "inventory-digest", "profile-owners-file", "offline"]),
      verify: new Set(["stage", "manifest-digest"]),
      adopt: new Set(["data", "stage", "manifest-digest", "profile-owners-file", "offline"]),
      apply: new Set(["data", "stage", "manifest-digest", "profile-owners-file", "offline"]),
    };
    if (Object.keys(values).some((key) => key !== "help" && !allowed[command].has(key))) fail("usage");

    const required = (name: "data" | "stage" | "inventory-digest" | "manifest-digest"): string => {
      const result = values[name];
      if (typeof result !== "string" || !result.trim()) fail("usage");
      return result;
    };
    const offline = (): void => {
      if (values.offline !== true) fail("offline-required");
    };
    const profileOwnersFile = typeof values["profile-owners-file"] === "string"
      ? values["profile-owners-file"]
      : undefined;

    if (command === "inventory") {
      const result = inventoryLegacyMigration({
        dataDir: required("data"),
        ...(profileOwnersFile ? { profileOwnersFile } : {}),
      });
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
      process.exitCode = result.issues.length || !result.safeToStage ? 2 : 0;
    } else if (command === "stage") {
      offline();
      const result = stageLegacyMigration({
        dataDir: required("data"),
        stageDir: required("stage"),
        expectedInventoryDigest: required("inventory-digest"),
        ...(profileOwnersFile ? { profileOwnersFile } : {}),
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
      process.exitCode = result.status === "verified" ? 0 : 2;
    } else if (command === "verify") {
      const result = verifyMigrationStage(required("stage"), required("manifest-digest"));
      print({
        migrationId: result.id,
        status: result.status,
        inventoryDigest: result.inventory.inventoryDigest,
        manifestDigest: result.manifestDigest,
        plannedAdoptions: result.inventory.plannedAdoptions,
        issues: result.inventory.issues,
      });
      process.exitCode = result.status === "verified" ? 0 : 2;
    } else if (command === "adopt") {
      offline();
      print(applyLegacyResourceAdoptions({
        dataDir: required("data"),
        stageDir: required("stage"),
        expectedManifestDigest: required("manifest-digest"),
        ...(profileOwnersFile ? { profileOwnersFile } : {}),
      }));
    } else {
      offline();
      print(applyLegacyIdentityMigration({
        dataDir: required("data"),
        stageDir: required("stage"),
        expectedManifestDigest: required("manifest-digest"),
        ...(profileOwnersFile ? { profileOwnersFile } : {}),
      }));
    }
  }
} catch (cause) {
  // Never echo parse errors or user-supplied paths/digests; they may contain
  // credentials or private installation details copied into the command line.
  const candidate = (cause as NodeJS.ErrnoException | null)?.code;
  const code = typeof candidate === "string" && /^(?:stage-|source-|unsafe-|invalid-|unexpected-|unreadable-|migration-|canonical-|recovery-|offline-required|usage)$/.test(candidate)
    ? candidate
    : "migration-failed";
  process.stderr.write(`${JSON.stringify({ error: code, hint: "Run npm run migration:legacy -- --help" })}\n`);
  process.exitCode = 1;
}
