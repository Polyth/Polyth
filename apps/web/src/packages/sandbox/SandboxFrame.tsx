import { useEffect, useState, type ReactNode } from "react";
import type { InstalledPluginDto } from "@polyth/contracts";
import type { RemoteUiAction, RemoteUiNode } from "@polyth/package-sdk";
import { EmptyState } from "../../components/ui/index.ts";
import { tr } from "../../i18n/index.ts";
import { RemoteUiView } from "./RemoteUi.tsx";
import { acquireSandboxRuntime, type SandboxRuntime } from "./runtime.ts";

export function SandboxFrame(props: {
  plugin: InstalledPluginDto;
  surfaceId: string;
}): ReactNode {
  const [tree, setTree] = useState<RemoteUiNode | null>(null);
  const [error, setError] = useState("");
  const [runtime, setRuntime] = useState<SandboxRuntime | null>(null);

  useEffect(() => {
    let active = true;
    let acquired: SandboxRuntime | null = null;
    let unsubscribe: (() => void) | undefined;
    void acquireSandboxRuntime(props.plugin, props.surfaceId).then((next) => {
      if (!active) {
        next.dispose();
        return;
      }
      acquired = next;
      setRuntime(next);
      unsubscribe = next.subscribe(setTree);
    }, (cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      active = false;
      unsubscribe?.();
      acquired?.dispose();
    };
  }, [props.plugin.id, props.plugin.sandbox?.integrity, props.plugin.version, props.surfaceId, JSON.stringify(props.plugin.permissions.effective)]);

  const onAction = (action: RemoteUiAction) => runtime?.sendAction(action);

  if (error) {
    return (
      <EmptyState
        variant="panel"
        title={tr("packages.plugins.failedToStart")}
        description={error}
      />
    );
  }
  return <RemoteUiView tree={tree} onAction={onAction} />;
}
