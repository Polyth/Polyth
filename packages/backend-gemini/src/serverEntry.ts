import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerAcpProfile } from "@polyth/backend-acp";
import {
  discoverHarnessExecutable,
  harnessExecutableChildEnv,
} from "@polyth/backend-acp/executable-discovery";
import type { RegisteredAcpProfile } from "@polyth/backend-acp/profile";
import type { ServerPackageHost } from "@polyth/plugins";

const exec = promisify(execFile);
const windowsShim = (command: string) =>
  process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

const resolveGeminiBinary = async () => {
  const requested = process.env.POLYTH_GEMINI_BIN?.trim() || "gemini";
  const report = await discoverHarnessExecutable(requested);
  if (!report.hit) {
    throw Object.assign(new Error("Gemini CLI was not found"), { code: "not-installed" });
  }
  const command = report.hit.executablePath;
  const env = await harnessExecutableChildEnv(command);
  const { stdout, stderr } = await exec(command, ["--version"], {
    timeout: 5_000,
    maxBuffer: 16 * 1024,
    env,
    shell: windowsShim(command),
    windowsHide: true,
  });
  process.env.PATH = env.PATH;
  return { command, version: String(stdout || stderr || "").trim() || undefined };
};

export default function registerPackage(host: ServerPackageHost) {
  const profile: RegisteredAcpProfile = {
    descriptor: {
      id: "gemini",
      name: "Gemini CLI",
      integration: "ACP v1",
      autoSelect: false,
      priority: 45,
      setupUrl: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md",
      installCommand: "npm install -g @google/gemini-cli",
    },
    command: process.env.POLYTH_GEMINI_BIN?.trim() || "gemini",
    args: ["--acp"],
    async probe(context) {
      if (context.remote) {
        return {
          harnessId: "gemini",
          installed: false,
          authenticated: "unknown",
          healthy: false,
          message: "Local execution only",
        };
      }
      try {
        const { command, version } = await resolveGeminiBinary();
        profile.command = command;
        return {
          harnessId: "gemini",
          installed: true,
          authenticated: "unknown",
          healthy: true,
          ...(version ? { version } : {}),
          message: "Authentication is negotiated by Gemini CLI through ACP",
        };
      } catch {
        return {
          harnessId: "gemini",
          installed: false,
          authenticated: "unknown",
          healthy: false,
          state: "not-installed" as const,
        };
      }
    },
  };

  return registerAcpProfile(host, profile);
}
