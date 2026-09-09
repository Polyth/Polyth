import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, chmod, constants, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const here = import.meta.dirname;
const source = join(here, "native", "polyth-supervisor.c");
const binRoot = join(here, "native", "bin");
await mkdir(binRoot, { recursive: true });

if (process.platform !== "linux") process.exit(0);

const requested = process.argv[2]?.replace(/^--target=/, "");
const target = requested || `linux-${process.arch}`;
if (target !== "linux-x64" && target !== "linux-arm64") {
  throw new Error(`unsupported Polyth runtime supervisor target: ${target}`);
}

const targetArch = target.slice("linux-".length);
const compiler = process.env.CC
  ?? (targetArch === process.arch
    ? "cc"
    : targetArch === "x64"
      ? "x86_64-linux-gnu-gcc"
      : "aarch64-linux-gnu-gcc");
const flags = [
  "-std=c11",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-static-pie",
  "-Wl,-z,relro,-z,now",
];
const outputDir = join(binRoot, target);
const output = join(outputDir, "polyth-supervisor");
const stamp = `${output}.sha256`;
await mkdir(outputDir, { recursive: true });
const digest = createHash("sha256")
  .update(await readFile(source))
  .update(JSON.stringify({ compiler, flags, target }))
  .digest("hex");
const current = await readFile(stamp, "utf8").catch(() => "");
if (current.trim() === digest
  && await access(output, constants.X_OK).then(() => true, () => false)) process.exit(0);

const temporary = `${output}.tmp-${process.pid}`;
const compiled = spawnSync(compiler, [...flags, source, "-o", temporary], { stdio: "inherit" });
if (compiled.error) {
  throw new Error(`failed to run ${compiler} for the Polyth runtime supervisor`, { cause: compiled.error });
}
if (compiled.status !== 0) {
  await rm(temporary, { force: true });
  throw new Error(`failed to build the Polyth runtime supervisor for ${target}`);
}
const elf = await readFile(temporary);
const expectedMachine = targetArch === "x64" ? 62 : 183;
if (elf.length < 20
  || !elf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  || elf.readUInt16LE(18) !== expectedMachine) {
  await rm(temporary, { force: true });
  throw new Error(`compiler ${compiler} did not produce a ${target} ELF executable`);
}
await chmod(temporary, 0o755);
await rename(temporary, output);
await writeFile(stamp, `${digest}\n`, { mode: 0o600 });
