// Temporary (2026-11-25): the one way to get the Send press trace off a phone
// (composer/sendPress.ts). A press that did nothing leaves no error to copy,
// so the person copies the trace here and pastes it to the agent or into a bug
// report. Remove this with its row, or move both to a debug menu, once the
// phone Send report is closed (docs/dev/ui.md, "The Send press").
import { useEffect, useRef, useState } from "react";
import { announce } from "../a11y/announce.ts";
import { sendPressReport } from "../../composer/sendPress.ts";
import { tr } from "../../i18n/index.ts";
import { copyText } from "../../utils.ts";
import { Button } from "../ui/index.ts";

/** How long the button says what the copy did before it offers itself again. */
const RESULT_MS = 2_000;

export default function SendDiagnosticsButton() {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const copy = () => {
    void copyText(sendPressReport()).then((copied) => {
      const next = copied ? "copied" : "failed";
      setResult(next);
      announce(tr(copied ? "settings.chatPage.sendDiagnosticsCopied" : "settings.chatPage.sendDiagnosticsFailed"));
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setResult(null);
      }, RESULT_MS);
    });
  };
  return (
    <Button size="sm" onClick={copy}>
      {result === "copied"
        ? tr("settings.chatPage.sendDiagnosticsCopied")
        : result === "failed"
          ? tr("settings.chatPage.sendDiagnosticsFailed")
          : tr("common.copy")}
    </Button>
  );
}
