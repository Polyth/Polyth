import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { access, chmod, constants, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const here = import.meta.dirname;
const source = join(here, "native", "polyth-supervisor.c");
const binRoot = join(here, "native", "bin");
await mkdir(binRoot, { recursive: true });

if (process.platform === "win32") {
  await buildWindowsJobHelper();
  process.exit(0);
}
if (process.platform !== "linux") process.exit(0);

/** polyth-job.exe, the Windows execution boundary, compiled by the C# compiler
 *  of the .NET Framework 4.x that Windows ships, so it needs no toolchain. One
 *  AnyCPU binary runs natively on x64 and arm64. Without that compiler the
 *  helper is skipped: harnesses then fall back to the portable authority,
 *  which fences after a crash until reboot. The desktop build requires it. */
async function buildWindowsJobHelper() {
  const windows = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const compiler = process.env.POLYTH_CSC
    ?? ["Framework64", "Framework"]
      .map((framework) => join(windows, "Microsoft.NET", framework, "v4.0.30319", "csc.exe"))
      .find((candidate) => existsSync(candidate));
  if (!compiler) {
    console.warn("polyth-job.exe not built: no .NET Framework C# compiler (csc.exe) found");
    return;
  }
  const jobSource = join(here, "native", "polyth-job.cs");
  const flags = ["/nologo", "/target:exe", "/platform:anycpu", "/optimize+", "/warnaserror+", "/debug-"];
  const outputDir = join(binRoot, "win32");
  const output = join(outputDir, "polyth-job.exe");
  const stamp = `${output}.sha256`;
  await mkdir(outputDir, { recursive: true });
  const digest = createHash("sha256")
    .update(await readFile(jobSource))
    .update(JSON.stringify({ flags, target: "win32" }))
    .digest("hex");
  const current = await readFile(stamp, "utf8").catch(() => "");
  if (current.trim() === digest && existsSync(output)) return;
  const temporary = join(outputDir, `polyth-job.tmp-${process.pid}.exe`);
  const compiled = spawnSync(compiler, [...flags, `/out:${temporary}`, jobSource], { stdio: "inherit" });
  if (compiled.error) throw new Error(`failed to run ${compiler} for polyth-job.exe`, { cause: compiled.error });
  if (compiled.status !== 0) {
    await rm(temporary, { force: true });
    throw new Error("failed to build polyth-job.exe");
  }
  const image = await readFile(temporary);
  if (image.length < 64 || image[0] !== 0x4d || image[1] !== 0x5a) {
    await rm(temporary, { force: true });
    throw new Error(`compiler ${compiler} did not produce a Windows executable`);
  }
  await rm(output, { force: true });
  await rename(temporary, output);
  await writeFile(stamp, `${digest}\n`);
}

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
