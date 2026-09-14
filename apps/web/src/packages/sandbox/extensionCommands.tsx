import { createRoot, type Root } from "react-dom/client";
import { parseExtensionCommandId } from "@polyth/commands/catalog";
import { api } from "@polyth/session/web-api";
import { SandboxCommandInvocationOverlay } from "./Contribution.tsx";

interface ActiveCommandHost {
  root: Root;
  node: HTMLDivElement;
}

let activeCommandHost: ActiveCommandHost | null = null;

function disposeHost(host: ActiveCommandHost): void {
  if (activeCommandHost === host) activeCommandHost = null;
  queueMicrotask(() => {
    host.root.unmount();
    host.node.remove();
  });
}

function disposeActiveCommand(): void {
  const current = activeCommandHost;
  if (current) disposeHost(current);
}

export interface ExtensionCommandLaunchInput {
  commandId: string;
  query: string;
  arguments?: string;
  sessionId?: string;
  projectId?: string;
}

/**
 * Resolve an authoritative installed-package descriptor, then mount a temporary
 * host-owned React root for the same contribution overlay used by buttons and
 * providers. The extension never receives a DOM node and never renders into
 * the host realm; its UI remains bounded RemoteUI inside the sandbox runtime.
 */
export async function launchExtensionCommand(input: ExtensionCommandLaunchInput): Promise<void> {
  const binding = parseExtensionCommandId(input.commandId);
  if (!binding) throw new Error("extension command identity is invalid");

  const plugins = await api.pluginsList();
  const plugin = plugins.find((candidate) =>
    candidate.id === binding.packageId
    && candidate.enabled
    && candidate.status === "ready"
    && candidate.runtimeKind === "sandboxed");
  if (!plugin) throw new Error("extension command package is not available in this Space");

  const contribution = plugin.contributions.find((item) =>
    item.module === `sandbox-contribution:command:${binding.contributionId}`);
  if (!contribution) throw new Error("extension command is no longer declared");

  const label = typeof contribution.props?.label === "string" && contribution.props.label.trim()
    ? contribution.props.label.trim()
    : binding.contributionId;

  disposeActiveCommand();
  const node = document.createElement("div");
  node.dataset.polythExtensionCommandHost = "true";
  document.body.appendChild(node);
  const root = createRoot(node);
  const host = { root, node };
  activeCommandHost = host;
  root.render(
    <SandboxCommandInvocationOverlay
      plugin={plugin}
      contributionId={binding.contributionId}
      label={label}
      query={input.query}
      {...(input.arguments ? { arguments: input.arguments } : {})}
      {...(input.sessionId ? { sessionId: input.sessionId } : {})}
      {...(input.projectId ? { projectId: input.projectId } : {})}
      onClose={() => disposeHost(host)}
    />,
  );
}
