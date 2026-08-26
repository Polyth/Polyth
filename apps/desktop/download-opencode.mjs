import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";

const here = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(join(here, "opencode.json"), "utf8"));
const platform = process.env.POLYTH_TARGET_PLATFORM ?? process.platform;
const arch = process.env.POLYTH_TARGET_ARCH ?? process.env.npm_config_arch ?? process.arch;
const key = `${platform}-${arch}`;
const target = lock.targets[key];

if (!target) {
  throw new Error(`No pinned OpenCode binary for ${key}`);
}

const url = `https://github.com/${lock.repository}/releases/download/v${lock.version}/${target.archive}`;
const work = await mkdtemp(join(tmpdir(), "polyth-opencode-"));

async function locateBinary(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await locateBinary(path);
      if (nested) return nested;
    } else if (entry.name === "opencode" || entry.name === "opencode.exe") {
      return path;
    }
  }
  return null;
}

const extractZipBinary = (archivePath, outputDir) => new Promise((resolveExtract, rejectExtract) => {
  yauzl.open(archivePath, { lazyEntries: true }, (openError, zip) => {
    if (openError || !zip) {
      rejectExtract(openError ?? new Error(`Could not open ${basename(archivePath)}`));
      return;
    }
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      zip.close();
      rejectExtract(error);
    };
    zip.once("error", fail);
    zip.once("end", () => {
      if (!settled) fail(new Error(`${basename(archivePath)} did not contain an OpenCode executable`));
    });
    zip.on("entry", (entry) => {
      const name = basename(entry.fileName);
      if (name !== "opencode" && name !== "opencode.exe") {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (streamError, stream) => {
        if (streamError || !stream) {
          fail(streamError ?? new Error(`Could not read ${entry.fileName}`));
          return;
        }
        void pipeline(stream, createWriteStream(join(outputDir, name), { mode: 0o700 }))
          .then(() => {
            if (settled) return;
            settled = true;
            zip.close();
            resolveExtract();
          }, fail);
      });
    });
    zip.readEntry();
  });
});

try {
  console.log(`[desktop] downloading OpenCode ${lock.version} for ${key}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`OpenCode download failed: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== target.sha256) {
    throw new Error(`OpenCode checksum mismatch for ${target.archive}: expected ${target.sha256}, got ${digest}`);
  }

  const archivePath = join(work, basename(target.archive));
  await writeFile(archivePath, bytes);
  const unpack = join(work, "unpack");
  await mkdir(unpack);
  if (target.archive.endsWith(".zip")) {
    await extractZipBinary(archivePath, unpack);
  } else {
    const extracted = spawnSync("tar", ["-xf", archivePath, "-C", unpack], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (extracted.status !== 0) {
      throw new Error(`Could not extract ${target.archive}: ${extracted.stderr || extracted.stdout}`);
    }
  }

  const source = await locateBinary(unpack);
  if (!source) throw new Error(`${target.archive} did not contain an OpenCode executable`);
  const outputDir = join(here, "resources", "opencode", key);
  const output = join(outputDir, platform === "win32" ? "opencode.exe" : "opencode");
  await mkdir(outputDir, { recursive: true });
  await rm(join(outputDir, platform === "win32" ? "opencode" : "opencode.exe"), { force: true });
  await copyFile(source, output);
  if (platform !== "win32") await chmod(output, 0o755);
  await writeFile(join(outputDir, "provenance.json"), `${JSON.stringify({
    version: lock.version,
    platform,
    arch,
    archive: target.archive,
    sha256: target.sha256,
  }, null, 2)}\n`);

  if (platform === process.platform && arch === process.arch) {
    const checked = spawnSync(output, ["--version"], { encoding: "utf8" });
    if (checked.status !== 0 || checked.stdout.trim() !== lock.version) {
      throw new Error(`Downloaded OpenCode version check failed: ${checked.stderr || checked.stdout}`);
    }
  }
  console.log(`[desktop] OpenCode ${lock.version} ready at ${output}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
