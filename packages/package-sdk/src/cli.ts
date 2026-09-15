#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parsePackageManifestJson,
  requiredAssets,
  type PackageManifest,
  type PackageManifestV2,
} from "./manifest.ts";
import { packDirectory } from "./pack.ts";

const help = `polyth-package <command>

Commands:
  validate <dir>     Validate a package manifest and required assets
  doctor <dir>       Explain extension contract, assets, and capability issues
  pack <dir> [out]   Write a zip of the package (default: <id>-<version>.zip)
`;

function assertAssets(dir: string, manifest: PackageManifest): void {
  for (const asset of requiredAssets(manifest)) {
    const path = join(dir, asset);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`missing required asset ${asset}`);
    }
  }
}

function loadManifest(dir: string): PackageManifest {
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

interface DoctorFinding {
  level: "error" | "warning" | "info";
  message: string;
}

function doctor(dir: string, manifest: PackageManifest): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const asset of requiredAssets(manifest)) {
    const path = join(dir, asset);
    if (!existsSync(path) || !statSync(path).isFile()) {
      findings.push({ level: "error", message: `Missing required asset: ${asset}` });
    }
  }

  const runtime = manifest.runtime;
  if (runtime?.kind === "trusted-local") {
    findings.push({
      level: "info",
      message: "Trusted-local execution is accepted only from an explicitly trusted local source.",
    });
  }

  if (manifest.manifestVersion === 2) {
    const v2 = manifest as PackageManifestV2;
    const contributions = v2.contributes;
    const handlerCount =
      (contributions?.composerActions?.length ?? 0)
      + (contributions?.attachmentProviders?.length ?? 0)
      + (contributions?.messageActions?.length ?? 0)
      + (contributions?.sessionActions?.length ?? 0)
      + (contributions?.commands?.length ?? 0)
      + (contributions?.statusBadges?.length ?? 0)
      + (contributions?.settingsSections?.length ?? 0)
      + (contributions?.contextProviders?.length ?? 0)
      + (contributions?.widgets?.length ?? 0)
      + (contributions?.surfaces?.length ?? 0)
      + (contributions?.toolRenderers?.filter((renderer) => renderer.dynamic).length ?? 0);
    if (handlerCount > 0 && (!runtime || runtime.kind !== "sandboxed" || !runtime.ui?.entry)) {
      findings.push({
        level: "error",
        message: "Interactive or dynamic contributions require a sandboxed runtime UI entry.",
      });
    }
    const declarativeRenderers = contributions?.toolRenderers?.filter((renderer) => !renderer.dynamic).length ?? 0;
    if (declarativeRenderers > 0) {
      findings.push({
        level: "info",
        message: `${declarativeRenderers} declarative tool renderer${declarativeRenderers === 1 ? "" : "s"} can render without activating the sandbox runtime.`,
      });
    }
  }

  const authRequested = manifest.capabilities?.some((capability) => capability.name === "auth.connection") ?? false;
  if (authRequested && (manifest.connections?.length ?? 0) === 0) {
    findings.push({ level: "warning", message: "auth.connection is requested but no connection is declared." });
  }
  const network = manifest.capabilities?.find((capability) => capability.name === "network.fetch");
  if (network?.constraints?.origins?.length) {
    findings.push({
      level: "info",
      message: `Network access is limited to ${network.constraints.origins.join(", ")}.`,
    });
  }
  for (const capability of manifest.capabilities ?? []) {
    if (capability.required === false) {
      findings.push({ level: "info", message: `${capability.name} is optional and does not block activation when denied.` });
    }
  }
  if (!findings.some((finding) => finding.level === "error")) {
    findings.push({ level: "info", message: `${manifest.id}@${manifest.version} is structurally ready for packaging.` });
  }
  return findings;
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
  } else if (command === "doctor") {
    if (!dir) throw new Error("doctor requires a directory");
    const manifest = loadManifest(dir);
    const findings = doctor(dir, manifest);
    for (const finding of findings) process.stdout.write(`${finding.level}: ${finding.message}\n`);
    if (findings.some((finding) => finding.level === "error")) process.exitCode = 1;
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
