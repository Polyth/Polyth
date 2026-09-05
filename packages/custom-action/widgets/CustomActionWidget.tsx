import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { createApiTransport, type WidgetRenderContext, type WidgetSettingsContext } from "@polyth/web-sdk";
import {
  AssistIcon,
  BellIcon,
  Button,
  ClockIcon,
  CopyIcon,
  Dialog,
  GlobeIcon,
  PackageIcon,
  PlayIcon,
  RefreshIcon,
  Select,
  SendIcon,
  TargetIcon,
  TerminalIcon,
  Textarea,
  TextInput,
  type LucideIcon,
} from "../../../apps/web/src/components/ui/index.ts";
import { ACTION_ICONS, actionConfig, type ActionIcon } from "./actionConfig.ts";

const api = createApiTransport();
const OUTPUT_LIMIT = 200_000;

const ICONS: Record<ActionIcon, { label: string; icon: LucideIcon }> = {
  terminal: { label: "Terminal", icon: TerminalIcon },
  play: { label: "Play", icon: PlayIcon },
  sparkles: { label: "Sparkles", icon: AssistIcon },
  refresh: { label: "Refresh", icon: RefreshIcon },
  target: { label: "Target", icon: TargetIcon },
  globe: { label: "Globe", icon: GlobeIcon },
  package: { label: "Package", icon: PackageIcon },
  bell: { label: "Bell", icon: BellIcon },
  clock: { label: "Clock", icon: ClockIcon },
  send: { label: "Send", icon: SendIcon },
};

interface RunView {
  open: boolean;
  output: string;
  state: "running" | "completed" | "failed";
  exitCode?: number | null;
  error?: string;
}

const appendOutput = (current: string, chunk: string): string =>
  (current + chunk).slice(-OUTPUT_LIMIT);

function terminalSocketUrl(id: string): string {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.host}/ws/terminal/${encodeURIComponent(id)}`;
}

export function CustomActionWidget({
  projectId,
  sessionId,
  config,
  openTerminal,
}: WidgetRenderContext & { openTerminal: () => void }) {
  const action = actionConfig(config);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunView>({ open: false, output: "", state: "running" });
  const terminalId = useRef<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const generation = useRef(0);

  const disposeRun = () => {
    generation.current++;
    socket.current?.close();
    socket.current = null;
    const id = terminalId.current;
    terminalId.current = null;
    if (id) void api.delete(`/api/terminals/${encodeURIComponent(id)}`).catch(() => {});
  };

  useEffect(() => () => disposeRun(), []);

  const close = () => {
    disposeRun();
    setRun((current) => ({ ...current, open: false }));
  };

  const execute = async () => {
    const command = action.command.trim();
    if (!projectId || !command || busy) return;
    setBusy(true);
    const token = ++generation.current;
    try {
      const created = await api.post<{ terminalId: string }>("/api/terminals", {
        projectId,
        ...(sessionId ? { sessionId } : {}),
        cmd: command,
      });
      if (generation.current !== token) {
        void api.delete(`/api/terminals/${encodeURIComponent(created.terminalId)}`).catch(() => {});
        return;
      }
      terminalId.current = created.terminalId;
      if (action.output === "terminal") {
        window.dispatchEvent(new CustomEvent("polyth:terminal-created", {
          detail: { terminalId: created.terminalId, projectId, title: action.label },
        }));
        terminalId.current = null;
        openTerminal();
        return;
      }

      setRun({ open: true, output: "", state: "running" });
      const ws = new WebSocket(terminalSocketUrl(created.terminalId));
      socket.current = ws;
      let finished = false;
      ws.onmessage = (event) => {
        let message: { type?: string; data?: string; exitCode?: number | null };
        try { message = JSON.parse(String(event.data)) as typeof message; } catch { return; }
        if (message.type === "replay" && typeof message.data === "string") {
          setRun((current) => ({ ...current, output: message.data!.slice(-OUTPUT_LIMIT) }));
        } else if (message.type === "data" && typeof message.data === "string") {
          setRun((current) => ({ ...current, output: appendOutput(current.output, message.data!) }));
        } else if (message.type === "exit") {
          finished = true;
          socket.current = null;
          ws.close();
          terminalId.current = null;
          void api.delete(`/api/terminals/${encodeURIComponent(created.terminalId)}`).catch(() => {});
          setRun((current) => ({ ...current, state: "completed", exitCode: message.exitCode ?? null }));
        }
      };
      ws.onerror = () => {
        if (!finished) setRun((current) => ({ ...current, state: "failed", error: "Could not read command output." }));
      };
      ws.onclose = () => {
        if (!finished && generation.current === token) {
          setRun((current) => ({ ...current, state: "failed", error: "The terminal connection closed." }));
        }
      };
    } catch (cause) {
      setRun({
        open: true,
        output: "",
        state: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      if (generation.current === token) setBusy(false);
    }
  };

  const Icon = ICONS[action.icon].icon;
  return (
    <>
      <Button
        className="custom-action custom-action-trigger"
        size="sm"
        variant="ghost"
        iconStart={Icon}
        aria-label={action.label}
        title={!projectId ? "Choose a project first" : !action.command.trim() ? "Configure a command first" : action.label}
        disabled={!projectId || !action.command.trim()}
        busy={busy}
        onClick={() => void execute()}
      />
      {run.open && typeof document !== "undefined" && createPortal(
        <Dialog
          title={action.label}
          onClose={close}
          size="lg"
          className="custom-action custom-action-output"
          footer={<>
            <Button
              size="sm"
              iconStart={CopyIcon}
              disabled={!run.output}
              onClick={() => void navigator.clipboard.writeText(run.output)}
            >Copy output</Button>
            <Button size="sm" variant="primary" onClick={close}>{run.state === "running" ? "Stop" : "Close"}</Button>
          </>}
        >
          <div className="custom-action-output-body">
            <div className={`custom-action-status is-${run.state}`} role="status">
              {run.state === "running"
                ? "Running…"
                : run.state === "failed"
                  ? run.error
                  : `Finished with exit code ${run.exitCode ?? "unknown"}`}
            </div>
            <code className="custom-action-command">$ {action.command}</code>
            <pre className="custom-action-result">{run.output || (run.state === "running" ? "Waiting for output…" : "No output")}</pre>
          </div>
        </Dialog>,
        document.body,
      )}
    </>
  );
}

export function CustomActionSettings({ config, updateConfig }: WidgetSettingsContext) {
  const action = actionConfig(config);
  const update = (patch: Partial<typeof action>) => updateConfig({ ...config, ...patch });
  return (
    <div className="custom-action custom-action-settings">
      <label>
        <span>Name</span>
        <TextInput value={action.label} placeholder="Run tests" onChange={(event) => update({ label: event.target.value })} />
      </label>
      <fieldset>
        <legend>Icon</legend>
        <div className="custom-action-icons">
          {ACTION_ICONS.map((name) => (
            <Button
              key={name}
              className="custom-action-icon-choice"
              size="sm"
              variant={action.icon === name ? "primary" : "ghost"}
              iconStart={ICONS[name].icon}
              aria-label={ICONS[name].label}
              aria-pressed={action.icon === name}
              title={ICONS[name].label}
              onClick={() => update({ icon: name })}
            />
          ))}
        </div>
      </fieldset>
      <label>
        <span>Command</span>
        <Textarea minRows={3} value={action.command} placeholder="npm test" onChange={(event) => update({ command: event.target.value })} />
        <small>Runs from the active session worktree, or the project root when no session is open.</small>
      </label>
      <label>
        <span>Show result</span>
        <Select
          label="Show result"
          value={action.output}
          options={[
            { value: "terminal", label: "Terminal", detail: "Open the command in Terminal" },
            { value: "popup", label: "Popup", detail: "Capture output in a result window" },
          ]}
          onChange={(output) => update({ output: output === "popup" ? "popup" : "terminal" })}
        />
      </label>
    </div>
  );
}
