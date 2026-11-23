// Header action on a shell code fence (`session.code.actions`). Opens the
// session's terminal and types the command; the person presses Enter.
import type { CodeBlockActionSlotContext, WebPackageHost } from "@polyth/web-sdk";
import { Button, TerminalIcon } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { requestTypeIntoTerminal, shellCommandFromBlock } from "./typeIntoTerminal.ts";

export default function RunInTerminalAction({ host, context }: { host: WebPackageHost; context: CodeBlockActionSlotContext }) {
  const command = context.streaming || !context.sessionId ? null : shellCommandFromBlock(context.lang, context.text);
  if (!command || !context.sessionId) return null;
  const sessionId = context.sessionId;
  return (
    <Button
      size="sm"
      variant="ghost"
      iconStart={TerminalIcon}
      title={tr("terminalview.runInTerminalHint")}
      onClick={() => {
        requestTypeIntoTerminal(sessionId, command);
        host.navigation.openWorkspacePane("terminal");
      }}
    >
      {tr("terminalview.runInTerminal")}
    </Button>
  );
}
