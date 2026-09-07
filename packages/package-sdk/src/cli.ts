#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePackageManifestJson, requiredAssets, type PackageManifestV1 } from "./manifest.ts";
import { packDirectory } from "./pack.ts";

const help = `polyth-package <command>

Commands:
  validate <dir>     Validate a package manifest and required assets
  pack <dir> [out]   Write a zip of the package (default: <id>-<version>.zip)
`;

function assertAssets(dir: string, manifest: PackageManifestV1): void {
  for (const asset of requiredAssets(manifest)) {
    const path = join(dir, asset);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`missing required asset ${asset}`);
    }
  }
}

function loadManifest(dir: string): PackageManifestV1 {
  const candidates = [
    join(dir, "polyth-package.json"),
    join(dir, "package.json"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const document = file.endsWith("package.json") && raw.polyth && typeof raw.polyth === "object"
      ? {
          ...(raw.polyth as Record<string, unknown>),
          id: (raw.polyth as { id?: unknown }).id ?? undefined,
          version: (raw.polyth as { version?: unknown }).version ?? raw.version,
          display: (raw.polyth as { display?: unknown }).display ?? {
            name: raw.name,
            description: (raw as { description?: unknown }).description,
          },
        }
      : raw;
    const parsed = parsePackageManifestJson(JSON.stringify(document));
    if (!parsed.ok) throw Object.assign(new Error(parsed.message), { code: parsed.code });
    return parsed.manifest;
  }
  throw Object.assign(new Error("no polyth-package.json or package.json polyth manifest"), {
    code: "invalid-input",
  });
}

const command = process.argv[2];
const dir = process.argv[3] ? resolve(process.argv[3]) : "";
if (!command || command === "--help" || command === "-h") {
  process.stdout.write(help);
  process.exit(command ? 0 : 1);
}

try {
  if (command === "validate") {
    if (!dir) throw new Error("validate requires a directory");
    const manifest = loadManifest(dir);
    assertAssets(dir, manifest);
    process.stdout.write(`${manifest.id}@${manifest.version} ok\n`);
  } else if (command === "pack") {
    if (!dir) throw new Error("pack requires a directory");
    const manifest = loadManifest(dir);
    assertAssets(dir, manifest);
    const out = process.argv[4]
      ? resolve(process.argv[4])
      : resolve(`${manifest.id}-${manifest.version}.zip`);
    writeFileSync(out, await packDirectory(dir));
    process.stdout.write(`${out}\n`);
  } else {
    throw new Error(`unknown command ${command}`);
  }
} catch (cause) {
  process.stderr.write(`${(cause as Error).message}\n`);
  process.exit(1);
}
