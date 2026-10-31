import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { npmCliInstallCommand, vendorScriptInstallCommand } from "../src/installers.ts";

const run = promisify(execFile);

test("the POSIX installer survives any login shell and needs no root", () => {
  const command = npmCliInstallCommand("@earendil-works/pi-coding-agent");
  assert.match(command, /^sh -c '/);
  const body = command.slice("sh -c '".length, -1);
  assert.doesNotMatch(body, /['\\]/, "single quotes or backslashes would break the outer quoting");
  assert.match(body, /npm install -g --prefix "\$P" @earendil-works\/pi-coding-agent$/);
  assert.match(body, /SHASUMS256\.txt/);
  assert.doesNotMatch(body, /sudo/);
});

const POWERSHELL = "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ";

/** The arguments a Windows program receives for `line` (the MSVCRT /
 *  CommandLineToArgvW rules PowerShell's host uses). */
const windowsArgv = (line: string): string[] => {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === "\\") {
      let slashes = 0;
      while (line[index] === "\\") { slashes++; index++; }
      if (line[index] === "\"") {
        current += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) current += "\"";
        else quoted = !quoted;
      } else {
        current += "\\".repeat(slashes);
        index--;
      }
      started = true;
    } else if (char === "\"") {
      quoted = !quoted;
      started = true;
    } else if ((char === " " || char === "\t") && !quoted) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
};

/** What `cmd.exe /d /s /c "<command>"` would act on: `/s` drops the outer
 *  quotes, `%` (and `!` under delayed expansion) expand everywhere, and
 *  `& | < > ( ) ^` are operators outside a quoted run. */
const cmdHazards = (command: string): string[] => {
  const hazards: string[] = [];
  let quoted = false;
  for (const char of command) {
    if (char === "\"") quoted = !quoted;
    else if (char === "%" || char === "!") hazards.push(char);
    else if (!quoted && "&|<>()^".includes(char)) hazards.push(char);
  }
  if (quoted) hazards.push("unclosed quote");
  return hazards;
};

/** Outside single-quoted strings, every bracket must close in order. */
const powershellBalance = (script: string): string | undefined => {
  const stack: string[] = [];
  let inString = false;
  for (const char of script) {
    if (char === "'") inString = !inString;
    else if (inString) continue;
    else if ("({[".includes(char)) stack.push(char);
    else if (")}]".includes(char)) {
      const open = stack.pop();
      if (open !== { ")": "(", "}": "{", "]": "[" }[char]) return `unbalanced ${char}`;
    }
  }
  if (inString) return "unclosed string";
  return stack.length ? `unclosed ${stack.join("")}` : undefined;
};

const windowsScript = (spec: string): string => {
  const command = npmCliInstallCommand(spec, "win32");
  assert.ok(command.startsWith(`${POWERSHELL}"`) && command.endsWith("\""), command.slice(0, 120));
  return command.slice(POWERSHELL.length + 1, -1);
};

test("the Windows npm installer is one line that cmd.exe and PowerShell pass through unchanged", () => {
  for (const spec of ["@openai/codex", "command-code@latest", "@opencode/cli"]) {
    const command = npmCliInstallCommand(spec, "win32");
    const script = windowsScript(spec);
    assert.doesNotMatch(script, /["%!^`\r\n]/, "no double quote, percent, exclamation mark, caret, backtick or line break");
    assert.doesNotMatch(script, /\\$/, "a trailing backslash would escape the closing quote");
    assert.deepEqual(cmdHazards(command), []);
    assert.deepEqual(windowsArgv(command), [
      "powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ]);
    assert.equal(powershellBalance(script), undefined);
    // The spec is the only input, as one literal argument.
    assert.equal(script.split(spec).length, 2);
    assert.ok(script.includes(`& $M install -g '${spec}'; exit $LASTEXITCODE`));
    assert.ok(script.endsWith("exit $LASTEXITCODE"));
  }
});

test("Windows installs Node.js per user, checksum-verified, never through an administrator", () => {
  const script = windowsScript("@openai/codex");
  for (const part of [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "[Net.SecurityProtocolType]::Tls12",
    "function Fail($Text){[Console]::Error.WriteLine($Text); exit 1}",
    "$N=Join-Path $env:LOCALAPPDATA 'Polyth\\node'",
    "$P=Join-Path $env:LOCALAPPDATA 'Polyth\\npm'",
    "$env:Path=$N+';'+$P+';'+$env:Path",
    "$M=Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1",
    "if(-not $M){",
    "$U='https://nodejs.org/dist/latest-v24.x'",
    "Invoke-WebRequest -UseBasicParsing -Uri ($U+'/SHASUMS256.txt')",
    "'([0-9a-f]{64}) +(node-v[0-9.]+-win-'+$A+'[.]zip)$'",
    "(Get-FileHash -Algorithm SHA256 -LiteralPath $F).Hash -ne $S",
    "Expand-Archive -LiteralPath $F -DestinationPath $T -Force",
    "}finally{Remove-Item -LiteralPath $T -Recurse -Force",
    "$env:npm_config_prefix=$P",
    "$ErrorActionPreference='Continue'; $LASTEXITCODE=1; & $M install -g",
  ]) assert.ok(script.includes(part), `missing: ${part}`);
  // Downloaded before it is checked, checked before it is unpacked, unpacked before npm runs.
  const order = ["PROCESSOR_ARCHITECTURE", "SHASUMS256.txt", "-OutFile $F", "Get-FileHash", "Expand-Archive", "& $M install"]
    .map((part) => script.indexOf(part));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(script, /winget|msiexec|\.msi\b|RunAs|-Verb|Start-Process|ProgramFiles|Program Files|sudo|Read-Host|SetEnvironmentVariable/i);
});

test("the Windows checksum line pattern picks exactly the zip for the machine", () => {
  const script = windowsScript("pkg");
  const pattern = /\$X -match \('([^']+)'\+\$A\+'([^']+)'\)/.exec(script);
  assert.ok(pattern, "the SHASUMS256.txt pattern");
  // Lines of nodejs.org/dist/latest-v24.x/SHASUMS256.txt (fetched 2026-10-25).
  const sums = [
    "aa26929d4ca7754aac3bd7fd018eb5c1c7961d00adf8aebf35c435d66edef62e  node-v24.22.1-win-arm64.7z",
    "a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171  node-v24.22.1-win-arm64.zip",
    "bf9245db3a3bb281da45fee3974a74403687ea6030587bee4fd992efc822c35c  node-v24.22.1-win-x64.7z",
    "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5  node-v24.22.1-win-x64.zip",
    "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5  win-x64/node.exe",
    "d61a585824e5504e1dfa0ceb7ad6981176f59531500303a97b790ccfe248a2c1  win-x64/node_pdb.zip",
  ];
  const pick = (arch: string) => {
    // PowerShell's -match is case-insensitive; the foreach keeps the last match.
    const regex = new RegExp(`${pattern[1]}${arch}${pattern[2]}`, "i");
    return sums.map((line) => regex.exec(line)).filter((match) => match !== null).map((match) => [match[1], match[2]]);
  };
  assert.deepEqual(pick("x64"), [["d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5", "node-v24.22.1-win-x64.zip"]]);
  assert.deepEqual(pick("arm64"), [["a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171", "node-v24.22.1-win-arm64.zip"]]);
});

test("each Windows failure is a plain, actionable sentence on stderr with exit 1", () => {
  const script = windowsScript("pkg");
  for (const message of [
    "Polyth cannot install Node.js on this Windows (",
    "Could not reach nodejs.org to download Node.js. Check the internet connection, then try again.",
    "nodejs.org did not list a Node.js 24 download for this Windows. Try again later.",
    "Downloading Node.js failed. Check the internet connection, then try again.",
    "The Node.js download was damaged (checksum mismatch). Try again.",
    "Unpacking Node.js into ",
    "Node.js was unpacked, but npm is missing from ",
  ]) assert.ok(script.includes(`'${message}`), `missing: ${message}`);
  // Only the AMD64 and ARM64 builds exist for Node.js 24.
  assert.ok(script.includes("if($A -eq 'AMD64'){$A='x64'}elseif($A -eq 'ARM64'){$A='arm64'}else{Fail ("));
  assert.equal(script.match(/exit 1/g)?.length, 1, "every failure goes through Fail");
});

test("vendor installer scripts run per platform, PowerShell only where the vendor ships one", () => {
  const input = { posix: "https://example.com/install.sh", windowsPowerShell: "https://example.com/install.ps1" };
  assert.equal(vendorScriptInstallCommand(input, "linux"), "curl -fsSL https://example.com/install.sh | bash");
  assert.equal(vendorScriptInstallCommand(input, "darwin"), "curl -fsSL https://example.com/install.sh | bash");
  assert.equal(vendorScriptInstallCommand({ ...input, posixShell: "sh" }), "curl -fsSL https://example.com/install.sh | sh");
  const windows = vendorScriptInstallCommand(input, "win32")!;
  assert.equal(windows, `${POWERSHELL}"[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; irm 'https://example.com/install.ps1' | iex"`);
  assert.deepEqual(cmdHazards(windows), []);
  assert.equal(windowsArgv(windows).length, 7);
  assert.equal(vendorScriptInstallCommand({ posix: input.posix }, "win32"), undefined);
  assert.throws(() => vendorScriptInstallCommand({ posix: input.posix, windowsPowerShell: "https://example.com/a%20b.ps1" }, "win32"));
  assert.throws(() => vendorScriptInstallCommand({ posix: "https://example.com/x y" }), /invalid installer URL/);
  assert.throws(() => vendorScriptInstallCommand({ posix: "http://example.com/x" }), /invalid installer URL/);
});

test("package specs are never shell syntax", () => {
  for (const spec of ["a b", "x;rm -rf ~", "$(id)", "pkg'", "", "p%PATH%", "p!x!", "p^&calc", "p\"x"]) {
    assert.throws(() => npmCliInstallCommand(spec), /invalid npm package spec/);
    assert.throws(() => npmCliInstallCommand(spec, "win32"), /invalid npm package spec/);
  }
});

test("an existing npm is used as is", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "polyth-npm-installer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const tool of ["sh", "uname"]) {
    const found = (await run("sh", ["-c", `command -v ${tool}`])).stdout.trim();
    await symlink(found, join(bin, tool));
  }
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$@" > "${join(root, "npm-args")}"\n`);
  await chmod(join(bin, "npm"), 0o755);
  const command = npmCliInstallCommand("@openai/codex");
  await run(join(bin, "sh"), ["-c", command], { env: { HOME: root, PATH: bin } });
  assert.equal((await readFile(join(root, "npm-args"), "utf8")).trim(), `install -g --prefix ${root}/.local @openai/codex`);
});
