// Third-party license notices for bundled output. A bundle copies dependency
// code into Polyth's own files, and most licenses (MIT, BSD, Apache-2.0, ISC)
// require their notice to travel with that code. Builds pass their esbuild
// metafiles here and ship the resulting THIRD_PARTY_NOTICES.txt next to the
// bundle.
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([-._].*)?$/i;
const RULE = "=".repeat(72);

/** The package directory that owns a bundled input, or null for own sources. */
export const packageRootOf = (path) => {
  const parts = path.split(sep);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return null;
  const length = parts[at + 1].startsWith("@") ? at + 3 : at + 2;
  return length > parts.length ? null : parts.slice(0, length).join(sep);
};

const declaredLicense = (manifest) => {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license.type === "string") return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses.map((entry) => (typeof entry === "string" ? entry : entry?.type)).filter(Boolean).join(" OR ");
  }
  return "";
};

const repositoryOf = (manifest) => {
  const repo = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  return typeof repo === "string" ? repo.replace(/^git\+/, "") : "";
};

/** Every third-party package an esbuild metafile's inputs come from. */
export const bundledPackages = (metafiles, workingDir = process.cwd()) => {
  const packages = new Map();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      if (/^[a-z-]+:/i.test(input) || input.startsWith("<")) continue; // namespaced/virtual inputs
      const root = packageRootOf(isAbsolute(input) ? input : resolve(workingDir, input));
      if (!root || packages.has(root)) continue;
      packages.set(root, readPackage(root));
    }
  }
  return [...packages.values()]
    .filter((pkg) => pkg !== null)
    .filter((pkg, index, all) => all.findIndex((other) => other.id === pkg.id) === index)
    .sort((a, b) => a.id.localeCompare(b.id));
};

/** A package's name, version, declared license and the license files it ships. */
export const readPackage = (root) => {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof manifest.name !== "string") return null;
  const files = readdirSync(root)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(root, name), "utf8").trim() }));
  return {
    id: `${manifest.name}@${manifest.version ?? ""}`,
    name: manifest.name,
    version: manifest.version ?? "",
    license: declaredLicense(manifest),
    repository: repositoryOf(manifest),
    author: typeof manifest.author === "string" ? manifest.author : manifest.author?.name ?? "",
    files,
  };
};

/** The notice text for a list of packages. */
export const formatNotices = (packages, product) => [
  `${product} includes the following third-party software. Each package is`,
  "listed with its version, declared license and the license text it ships.",
  "",
  ...packages.flatMap((pkg) => [
    RULE,
    `${pkg.name} ${pkg.version}`,
    `License: ${pkg.license || "not declared"}`,
    ...(pkg.repository ? [`Repository: ${pkg.repository}`] : []),
    ...(pkg.files.length === 0 && pkg.author ? [`Author: ${pkg.author}`] : []),
    "",
    ...(pkg.files.length === 0
      ? ["(The package ships no license file; its declared license applies.)", ""]
      : pkg.files.flatMap((file) => [`--- ${file.name}`, file.text, ""])),
  ]),
].join("\n");

/** Writes THIRD_PARTY_NOTICES.txt for bundles built with `metafile: true`.
 *  Fails when a bundled package declares no license and ships no license file:
 *  such code cannot be redistributed until its terms are known. */
export const writeThirdPartyNotices = async (file, metafiles, { product = "Polyth", workingDir } = {}) => {
  const packages = bundledPackages(metafiles, workingDir);
  const unknown = packages.filter((pkg) => !pkg.license && pkg.files.length === 0);
  if (unknown.length > 0) {
    throw new Error(`bundled packages without any license information: ${unknown.map((pkg) => pkg.id).join(", ")}`);
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${formatNotices(packages, product)}\n`);
  return packages;
};
