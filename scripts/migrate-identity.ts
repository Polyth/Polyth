// Explicit operator tool. Never called by startup, a package handler or auth UI.
import "./check-node.mjs";
import {parseArgs} from "node:util";
import {
  inventoryLegacyMigration, stageLegacyMigration, verifyMigrationStage,
} from "@polyth/tenancy";

const help = `Polyth identity migration preparation (no activation)

node --experimental-strip-types scripts/migrate-identity.ts inspect --data-dir DIR
node --experimental-strip-types scripts/migrate-identity.ts stage --data-dir DIR --stage-dir NEW_DIR --expect-inventory SHA256 --offline
node --experimental-strip-types scripts/migrate-identity.ts verify --stage-dir DIR --expect-manifest SHA256

--offline acknowledges that the installation and every legacy writer are stopped.
Before/after hashes detect drift, but cannot lock arbitrary external JSON writers.
Stage never overwrites source data or activates the new identity authority.
The private capsule covers identity migration inputs, not projects, attachments,
root encryption keys or an entire installation backup. Keep it confidential.
Record the manifest digest separately. Hash integrity is not authenticity.
Exit: 0 verified/no issues, 2 quarantined/review required, 1 usage/failure.
`;

try {
  const {values,positionals} = parseArgs({allowPositionals:true, strict:true, options:{
    "data-dir":{type:"string"}, "stage-dir":{type:"string"},
    "profile-owners-file":{type:"string"}, "expect-inventory":{type:"string"},
    "expect-manifest":{type:"string"}, offline:{type:"boolean"}, help:{type:"boolean",short:"h"},
  }});
  if (values.help) process.stdout.write(help);
  else {
    const command = positionals[0];
    if (positionals.length !== 1 || !["inspect","stage","verify"].includes(command ?? "")) throw new Error("usage");
    const allowed = command === "verify"
      ? ["stage-dir","expect-manifest"]
      : ["data-dir","profile-owners-file",...(command === "stage" ? ["stage-dir","expect-inventory","offline"] : [])];
    if (Object.keys(values).some(key=>!allowed.includes(key))) throw new Error("usage");
    const required = (key:"data-dir"|"stage-dir"|"expect-inventory"|"expect-manifest"):string => {
      const value = values[key];
      if (!value?.trim()) throw new Error("usage");
      return value;
    };
    if (command === "verify") {
      const result = verifyMigrationStage(required("stage-dir"),required("expect-manifest"));
      process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
      process.exitCode = result.status === "verified" ? 0 : 2;
    } else {
      const opts = {dataDir:required("data-dir"),profileOwnersFile:values["profile-owners-file"]};
      if (command === "inspect") {
        const result = inventoryLegacyMigration(opts);
        process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
        process.exitCode = result.issues.length ? 2 : 0;
      } else {
        if (values.offline !== true) throw Object.assign(new Error("offline-required"),{code:"offline-required"});
        const result = stageLegacyMigration({...opts,stageDir:required("stage-dir"),expectedInventoryDigest:required("expect-inventory")});
        process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
        process.exitCode = result.status === "verified" ? 0 : 2;
      }
    }
  }
} catch (cause) {
  // Usage errors can contain pasted command-line values; never echo them.
  const candidate = (cause as NodeJS.ErrnoException).code ?? "usage";
  const code = /^(?:stage-|source-|unsafe-|invalid-|unexpected-|unreadable-|offline-required)/.test(candidate) ? candidate : "usage-or-io-failure";
  process.stderr.write(`${JSON.stringify({error:code,hint:"Run with --help. No identity authority was activated."})}\n`);
  process.exitCode = 1;
}
