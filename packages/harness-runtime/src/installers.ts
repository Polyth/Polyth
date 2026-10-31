// Install commands for harness CLIs published on npm.
//
// A person setting up a harness may have no Node.js, no npm and no
// administrator rights, on this machine or on an SSH host. The command
// therefore brings its own prerequisites: it uses an npm already on PATH,
// otherwise it downloads the current Node.js LTS from nodejs.org
// (checksum-verified) into a per-user directory, and installs the CLI into a
// per-user prefix that Polyth already searches — `--prefix "$HOME/.local"` on
// POSIX, `%LOCALAPPDATA%\Polyth\npm` on Windows — so nothing needs root/UAC and
// nothing asks a question.

/** npm package spec: name, optional scope and dist-tag/version. */
const PACKAGE_SPEC_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9._-]+)?$/;

/** Node.js release line installed when the machine has none. */
const NODE_DIST = "https://nodejs.org/dist/latest-v24.x";

/** Windows directories, relative to `%LOCALAPPDATA%`, holding the Node.js the
 *  installer downloads and the npm prefix CLIs are installed into (npm puts a
 *  global install's `.cmd` shims directly in the prefix). Executable
 *  discovery searches both, and appends them to a launched CLI's PATH, so a
 *  shim's `node` fallback finds this Node.js. */
export const WINDOWS_NODE_DIR = ["Polyth", "node"] as const;
export const WINDOWS_NPM_PREFIX = ["Polyth", "npm"] as const;

const fail = (message: string): string => `{ echo "${message}" >&2; exit 1; }`;

/** POSIX `sh` body. It contains no single quote and no backslash, so it can be
 *  wrapped in single quotes for any login shell (bash, zsh, fish, …) and
 *  copied into a terminal unchanged. */
const posixScript = (spec: string): string => [
  'P="$HOME/.local"; N="$P/share/polyth/node"; PATH="$P/bin:$PATH"; export PATH',
  "if ! command -v npm >/dev/null 2>&1; then",
  '  echo "Node.js was not found; installing it for this user into $N"',
  '  case "$(uname -s)" in Linux) O=linux;; Darwin) O=darwin;; *) O=;; esac',
  '  case "$(uname -m)" in x86_64|amd64) A=x64;; aarch64|arm64) A=arm64;; *) A=;; esac',
  '  if [ -z "$O" ] || [ -z "$A" ] || { [ "$O" = linux ] && ldd --version 2>&1 | grep -qi musl; }; then',
  `    ${fail("Polyth cannot install Node.js on this system ($(uname -sm)) by itself. Install Node.js 20 or newer with the system package manager, then try again.")}`,
  "  fi",
  '  if command -v curl >/dev/null 2>&1; then G="curl -fsSL"; elif command -v wget >/dev/null 2>&1; then G="wget -qO-";',
  `  else ${fail("Neither curl nor wget is installed, so Node.js cannot be downloaded. Install one of them, then try again.")}; fi`,
  `  U=${NODE_DIST}; L=$($G "$U/SHASUMS256.txt" | grep " node-v[0-9.]*-$O-$A.tar.gz$")`,
  `  [ -n "$L" ] || ${fail("Could not reach nodejs.org to download Node.js. Check the internet connection, then try again.")}`,
  '  F=${L##* }; T=$(mktemp -d) && $G "$U/$F" > "$T/$F" || ' + fail("Downloading Node.js failed. Try again."),
  '  H=$( (sha256sum "$T/$F" 2>/dev/null || shasum -a 256 "$T/$F") | cut -d" " -f1)',
  `  [ "$H" = "\${L%% *}" ] || ${fail("The Node.js download was damaged (checksum mismatch). Try again.")}`,
  '  rm -rf "$N" && mkdir -p "$N" "$P/bin" && tar -xzf "$T/$F" -C "$N" --strip-components=1 || ' + fail("Unpacking Node.js failed."),
  '  rm -rf "$T"; ln -sf "$N/bin/node" "$N/bin/npm" "$N/bin/npx" "$P/bin/"',
  "fi",
  `npm install -g --prefix "$P" ${spec}`,
].join("\n");

/** A PowerShell single-quoted literal that also survives the `cmd.exe`
 *  command line around it: no quote of either kind, no `%` (expanded even
 *  inside quotes), no `!` (delayed expansion), no `^`, backtick or line break. */
const psLiteral = (text: string): string => {
  if (/['"%!^`\r\n]/.test(text)) throw new Error(`unsafe PowerShell literal: ${text}`);
  return `'${text}'`;
};

const psFail = (message: string): string => `Fail ${psLiteral(message)}`;
/** Inside a `catch`: the message, then what PowerShell reported. */
const psFailWithCause = (message: string): string => `Fail (${psLiteral(`${message} `)}+$_.Exception.Message)`;

/** Downloads Node.js into `$N` when no `npm.cmd` was found, then points `$M`
 *  at its npm. The temporary folder sits beside `$N` so the unpacked tree is
 *  renamed into place (same volume) and the paths stay short (Expand-Archive
 *  in Windows PowerShell 5.1 is bound by MAX_PATH). */
const windowsNodeInstall = (): string => [
  "Write-Output ('Node.js was not found; installing it for this user into '+$N)",
  "$A=$env:PROCESSOR_ARCHITEW6432",
  "if(-not $A){$A=$env:PROCESSOR_ARCHITECTURE}",
  "if($A -eq 'AMD64'){$A='x64'}elseif($A -eq 'ARM64'){$A='arm64'}"
    + `else{Fail (${psLiteral("Polyth cannot install Node.js on this Windows (")}+$A+${psLiteral(") by itself. Install Node.js 20 or newer from nodejs.org, then try again.")})}`,
  `$U=${psLiteral(NODE_DIST)}`,
  `$T=Join-Path $env:LOCALAPPDATA (${psLiteral(`${WINDOWS_NODE_DIR[0]}\\setup-`)}+[guid]::NewGuid().ToString('N').Substring(0,8))`,
  "New-Item -ItemType Directory -Force -Path $T | Out-Null",
  "try{" + [
    "$H=Join-Path $T 'SHASUMS256.txt'",
    `try{Invoke-WebRequest -UseBasicParsing -Uri ($U+'/SHASUMS256.txt') -OutFile $H}catch{${psFailWithCause("Could not reach nodejs.org to download Node.js. Check the internet connection, then try again.")}}`,
    "$S=''",
    "$Z=''",
    // No `^` anchor (cmd.exe's escape character); the line still starts with the hash.
    "foreach($X in (Get-Content -LiteralPath $H)){if($X -match ('([0-9a-f]{64}) +(node-v[0-9.]+-win-'+$A+'[.]zip)$')){$S=$Matches[1]; $Z=$Matches[2]}}",
    `if(-not $Z){${psFail("nodejs.org did not list a Node.js 24 download for this Windows. Try again later.")}}`,
    "$F=Join-Path $T $Z",
    `try{Invoke-WebRequest -UseBasicParsing -Uri ($U+'/'+$Z) -OutFile $F}catch{${psFailWithCause("Downloading Node.js failed. Check the internet connection, then try again.")}}`,
    `if((Get-FileHash -Algorithm SHA256 -LiteralPath $F).Hash -ne $S){${psFail("The Node.js download was damaged (checksum mismatch). Try again.")}}`,
    "try{Expand-Archive -LiteralPath $F -DestinationPath $T -Force; "
      + "if(-not(Test-Path -LiteralPath (Join-Path $N 'npm.cmd'))){"
      + "if(Test-Path -LiteralPath $N){Remove-Item -LiteralPath $N -Recurse -Force}; "
      + "Move-Item -LiteralPath (Join-Path $T ([IO.Path]::GetFileNameWithoutExtension($Z))) -Destination $N}}"
      + `catch{Fail (${psLiteral("Unpacking Node.js into ")}+$N+${psLiteral(" failed. ")}+$_.Exception.Message)}`,
  ].join("; ") + "}finally{Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue}",
  "$M=Join-Path $N 'npm.cmd'",
  `if(-not(Test-Path -LiteralPath $M)){Fail (${psLiteral("Node.js was unpacked, but npm is missing from ")}+$N+${psLiteral(". Delete that folder, then try again.")})}`,
].join("; ");

/**
 * Windows PowerShell 5.1 script for `powershell -Command "…"`, itself run by
 * the server as `cmd.exe /d /s /c "<command>"`. One line of single-quoted
 * strings: it contains no double quote, `%`, `!`, `^` or backtick, and does
 * not end with a backslash, so neither cmd.exe nor PowerShell's own argument
 * parsing alters it. Every failure writes one plain sentence to stderr and
 * exits 1; npm's own exit code is passed through. `npm.cmd` is called rather
 * than `npm`, whose `npm.ps1` re-parses the calling command line.
 */
const windowsScript = (spec: string): string => [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
  "function Fail($Text){[Console]::Error.WriteLine($Text); exit 1}",
  `if(-not $env:LOCALAPPDATA){${psFail("LOCALAPPDATA is not set, so there is no per-user folder to install into. Run Polyth as a signed-in Windows user, then try again.")}}`,
  `$N=Join-Path $env:LOCALAPPDATA ${psLiteral(WINDOWS_NODE_DIR.join("\\"))}`,
  `$P=Join-Path $env:LOCALAPPDATA ${psLiteral(WINDOWS_NPM_PREFIX.join("\\"))}`,
  "$env:Path=$N+';'+$P+';'+$env:Path",
  "$M=Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1",
  `if(-not $M){${windowsNodeInstall()}}`,
  // A setting, not an argument: the prefix path never passes through the
  // `.cmd` re-parse, whatever characters the profile folder has.
  "$env:npm_config_prefix=$P",
  // npm reports warnings on stderr; Windows PowerShell 5.1 may turn native
  // stderr into error records, which 'Stop' would make fatal.
  "$ErrorActionPreference='Continue'",
  // Still 1 if npm never started, so that is not reported as success.
  "$LASTEXITCODE=1",
  `& $M install -g ${psLiteral(spec)}`,
  "exit $LASTEXITCODE",
].join("; ");

/**
 * The command that installs the npm package `spec` with no prerequisites.
 * POSIX hosts (local or SSH) get a self-contained `sh -c` script; Windows gets
 * the PowerShell equivalent (per-user Node.js zip, SHA-256 checked, no winget,
 * MSI or UAC prompt).
 */
export function npmCliInstallCommand(spec: string, platform: NodeJS.Platform | "posix" = "posix"): string {
  if (!PACKAGE_SPEC_RE.test(spec)) throw new Error(`invalid npm package spec: ${spec}`);
  if (platform === "win32") return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${windowsScript(spec)}"`;
  return `sh -c '${posixScript(spec)}'`;
}

/**
 * A vendor's official installer script as a command for the server platform's
 * system shell: `curl … | <shell>` on POSIX, and on Windows the vendor's
 * PowerShell script started from `cmd.exe` (TLS 1.2 enabled first, so Windows
 * PowerShell 5.1 can fetch it; `-NonInteractive` turns a prompt into a
 * failure instead of a hang). Without a Windows script the harness has no
 * automatic installer there (Settings shows its setup guide).
 */
export function vendorScriptInstallCommand(
  input: { posix: string; posixShell?: "sh" | "bash"; windowsPowerShell?: string },
  platform: NodeJS.Platform | "posix" = "posix",
): string | undefined {
  const url = platform === "win32" ? input.windowsPowerShell : input.posix;
  if (url === undefined) return undefined;
  if (!/^https:\/\/[A-Za-z0-9./?=&_%-]+$/.test(url)) throw new Error(`invalid installer URL: ${url}`);
  if (platform !== "win32") return `curl -fsSL ${url} | ${input.posixShell ?? "bash"}`;
  // psLiteral also refuses a `%`, which cmd.exe would expand.
  return "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \""
    + "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; "
    + `irm ${psLiteral(url)} | iex"`;
}
