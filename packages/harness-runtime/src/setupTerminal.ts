// Harness install and sign-in terminals.
//
// The server, not the browser, picks the command and the machine it runs on,
// and runs it through the platform's system shell (`/bin/sh`, `cmd.exe`), so
// it neither depends on the person's terminal shell nor on a command string a
// client cached. Sign-in for this machine's CLI (and its extra accounts) runs
// here even when the open project lives on an SSH host; only a harness whose
// remote chats run on that host's own sign-in is set up on the host.
import { homedir } from "node:os";
import type {
    HarnessDescriptor,
    HarnessSetupAction,
    HarnessSetupTerminalDto,
    HarnessSetupTerminalPreviewDto,
    Project,
    RouteRequest,
    TerminalInfo,
} from "@polyth/contracts";
import { hasHarnessManagerAuthority, hasPersonalHarnessAuthority } from "@polyth/contracts/instance-authority";
import { mergeHarnessSearchPaths, probeHarnessLoginShellPath, wellKnownHarnessExecutableDirectories } from "./executableDiscovery.ts";
import { harnessError } from "./index.ts";

/** Per-user install locations on an SSH host, the same list remote harness
 *  launches search (the ssh package's REMOTE_HARNESS_PATH). */
export const REMOTE_SETUP_PATH =
    'PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/bin:/usr/local/bin:$PATH"; export PATH';

/** The slice of the terminal service a setup terminal needs. */
export interface HarnessSetupTerminals {
    create(input: {
        projectId: string;
        cwd: string;
        cmd: string;
        systemShell: true;
        local: boolean;
        env?: Readonly<Record<string, string>>;
        title: string;
        purpose: NonNullable<TerminalInfo["purpose"]>;
    }): Promise<{ id: string }>;
}

export const readSetupAction = (value: unknown): HarnessSetupAction => {
    if (value === "install" || value === "sign-in") return value;
    throw harnessError("invalid-input", "action must be install or sign-in");
};

/** Where a harness is set up for `project`: its SSH host only when chats of
 *  that project run this harness there on the host's own login. */
export const setupTarget = (descriptor: HarnessDescriptor, project: Pick<Project, "remote"> | undefined): "local" | "remote" =>
    project?.remote && descriptor.remoteHost?.sessions === true ? "remote" : "local";

/** Whether the caller's browser runs on this machine, so a CLI's
 *  `localhost` sign-in callback can reach it: a direct loopback request. A
 *  phone, Polyth Link, another computer or a proxied origin cannot. */
export const browserOnServer = (request: Pick<RouteRequest, "ingress">): boolean =>
    request.ingress.kind === "public-http" && request.ingress.loopback && request.ingress.proxied !== true;

/** The exact command a setup terminal runs, or undefined when the harness has
 *  none for that machine (the Settings page then offers its setup guide). */
export const setupCommand = (
    descriptor: HarnessDescriptor,
    action: HarnessSetupAction,
    target: "local" | "remote",
    localBrowser = true,
): { command: string; deviceCode: boolean } | undefined => {
    const device = action === "sign-in" && target === "local" && !localBrowser ? descriptor.deviceSignInCommand?.trim() : undefined;
    const command = device ?? (target === "remote"
        ? action === "install" ? descriptor.remoteHost?.installCommand : descriptor.remoteHost?.signInCommand
        : action === "install" ? descriptor.installCommand : descriptor.signInCommand)?.trim();
    return command ? { command, deviceCode: Boolean(device) } : undefined;
};

/** Who may open a setup terminal. Installing a CLI changes the machine for
 *  everyone, as does replacing a shared login; a private account is its
 *  owner's own (visibility already limits it to them). */
export const requireSetupAuthority = (request: RouteRequest, descriptor: HarnessDescriptor, action: HarnessSetupAction): void => {
    if (request.space.deployment === "multi-tenant-sandboxed")
        throw harnessError("forbidden", "Harness install and sign-in run on the server and are unavailable in a sandboxed deployment");
    if (action === "install" || !descriptor.accountOwnerUserId) {
        if (!hasHarnessManagerAuthority(request))
            throw harnessError("forbidden", action === "install"
                ? "Only the server owner or a harness manager can install a harness"
                : "Only the server owner or a harness manager can change this shared sign-in");
        return;
    }
    if (!hasPersonalHarnessAuthority(request))
        throw harnessError("forbidden", "Signing in to your own assistant accounts requires permission from the server owner");
};

/** PATH for a local setup terminal: what Polyth inherited, then the login
 *  shell's and the usual per-user install locations. A desktop launch from
 *  Finder or a service manager inherits a PATH without `~/.local/bin`, where
 *  installers put the CLI and the Node.js that npm CLIs need. */
export const localSetupEnv = async (env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> => {
    const inherited = env.PATH ?? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1];
    const login = await probeHarnessLoginShellPath({ env }).catch(() => undefined);
    return { PATH: mergeHarnessSearchPaths(inherited, login?.entries, wellKnownHarnessExecutableDirectories({ env })).join(process.platform === "win32" ? ";" : ":") };
};

export async function previewSetupTerminal(input: {
    descriptor: HarnessDescriptor;
    action: HarnessSetupAction;
    project: Pick<Project, "remote"> | undefined;
    /** See `browserOnServer`; defaults to true (the plain sign-in). */
    localBrowser?: boolean;
}): Promise<HarnessSetupTerminalPreviewDto> {
    const target = setupTarget(input.descriptor, input.project);
    const chosen = setupCommand(input.descriptor, input.action, target, input.localBrowser ?? true);
    if (!chosen) {
        throw harnessError("unsupported", input.action === "install"
            ? `${input.descriptor.name} has no automatic installer for ${target === "remote" ? "this SSH host" : "this machine"}; follow its setup guide`
            : `${input.descriptor.name} has no sign-in command for ${target === "remote" ? "this SSH host" : "this machine"}`);
    }
    return {
        harnessId: input.descriptor.id, action: input.action, target, command: chosen.command,
        ...(chosen.deviceCode ? { deviceCode: true } : {}),
    };
}

export async function openSetupTerminal(input: {
    descriptor: HarnessDescriptor;
    action: HarnessSetupAction;
    project: Pick<Project, "id" | "path" | "remote">;
    localBrowser?: boolean;
    terminals: HarnessSetupTerminals | undefined;
    env?: NodeJS.ProcessEnv;
}): Promise<HarnessSetupTerminalDto> {
    const preview = await previewSetupTerminal(input);
    if (!input.terminals) throw harnessError("unavailable", "The Terminal package is off, so Polyth cannot open a terminal for this");
    const remote = preview.target === "remote";
    const title = input.action === "install" ? `Install ${input.descriptor.name}` : `Sign in · ${input.descriptor.name}`;
    const { id } = await input.terminals.create({
        projectId: input.project.id,
        // A local setup has nothing to do with the project's files.
        cwd: remote ? input.project.path : homedir(),
        cmd: remote ? `${REMOTE_SETUP_PATH}; ${preview.command}` : preview.command,
        systemShell: true,
        local: !remote,
        ...(remote ? {} : { env: await localSetupEnv(input.env) }),
        title,
        purpose: "harness-setup",
    });
    return { ...preview, terminalId: id, projectId: input.project.id, title };
}
