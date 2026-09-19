import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerAcpProfile } from "@polyth/backend-acp";
import {
  discoverHarnessExecutable,
  harnessExecutableChildEnv,
} from "@polyth/backend-acp/executable-discovery";
import type { RegisteredAcpProfile } from "@polyth/backend-acp/profile";
import type { ServerPackageHost } from "@polyth/plugins";
import { translateGeminiPromptError, translateGeminiPromptResult } from "./protocol.ts";

const exec = promisify(execFile);
const windowsShim = (command: string) =>
  process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

const run = async (command: string, args: string[], timeout = 5_000): Promise<string> => {
  const env = await harnessExecutableChildEnv(command);
  const { stdout, stderr } = await exec(command, args, {
    timeout,
    maxBuffer: 256 * 1024,
    env,
    shell: windowsShim(command),
    windowsHide: true,
  });
  process.env.PATH = env.PATH;
  return String(stdout || stderr || "").trim();
};

export const inspectGeminiHelp = (output: string): boolean =>
  /(^|[\\s,])--acp(?=$|[\\s,=<])/m.test(output.replace(/\\x1b\\[[0-?]*[ -\\/]*[@-~]/g, ""));

const resolveGeminiBinary = async () => {
  const requested = process.env.POLYTH_GEMINI_BIN?.trim() || "gemini";
  const report = await discoverHarnessExecutable(requested);
  if (!report.hit) {
    throw Object.assign(new Error("Gemini CLI was not found"), { code: "not-installed" });
  }
  const command = report.hit.executablePath;
  const [version, help] = await Promise.all([
    run(command, ["--version"]),
    run(command, ["--help"]),
  ]);
  return {
    command,
    version: version || undefined,
    compatible: inspectGeminiHelp(help),
  };
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
      signInCommand: "gemini",
    },
    command: process.env.POLYTH_GEMINI_BIN?.trim() || "gemini",
    args: ["--acp"],
    runtimeFeatures: { usage: true },
    translatePromptResult: translateGeminiPromptResult,
    translatePromptError: translateGeminiPromptError,
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
        const { command, version, compatible } = await resolveGeminiBinary();
        profile.command = command;
        if (!compatible) {
          return {
            harnessId: "gemini",
            installed: true,
            authenticated: "unknown",
            healthy: false,
            state: "incompatible" as const,
            ...(version ? { version } : {}),
            message: "Upgrade Gemini CLI: the installed build does not expose official --acp mode",
          };
        }
        return {
          harnessId: "gemini",
          installed: true,
          authenticated: "unknown",
          healthy: true,
          ...(version ? { version } : {}),
          message: "Authentication is negotiated by Gemini CLI through ACP",
        };
      } catch (error) {
        const code = (error as { code?: string }).code;
        return {
          harnessId: "gemini",
          installed: code !== "not-installed",
          authenticated: "unknown",
          healthy: false,
          state: code === "not-installed" ? "not-installed" as const : "degraded" as const,
          message: code === "not-installed" ? undefined : "Gemini CLI is installed but could not be inspected",
        };
      }
    },
  };

  return registerAcpProfile(host, profile);
}
