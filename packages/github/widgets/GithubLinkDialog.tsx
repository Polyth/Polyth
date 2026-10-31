// Package-owned GitHub link dialog, opened through the generic composer
// Add-menu contribution seam. Link-only: nothing is fetched beyond the repo
// probe inside attachments.ts.
import { useState } from "react";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Dialog, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { isImeComposing } from "@polyth/web-sdk";
import { parseGithubUrl, type GithubAttachResult } from "./attachments.ts";

export function GithubLinkDialog({ attachGithub, onClose }: {
  attachGithub: (url: string) => Promise<GithubAttachResult>;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const valid = parseGithubUrl(url) !== null;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    const result = await attachGithub(url.trim());
    setBusy(false);
    if (result.ok) {
      onClose();
      return;
    }
    setError(result.reason.length > 300 ? `${result.reason.slice(0, 297)}…` : result.reason);
  };

  return (
    <Dialog
      title={tr("githubattach.dialogTitle")}
      onClose={onClose}
      className="github-link-dialog"
      initialFocus="input"
      footer={(
        <>
          <Button size="sm" onClick={onClose}>{tr("common.cancel")}</Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!valid || busy}
            onClick={() => void submit()}
          >
            {tr("githubattach.addLink")}
          </Button>
        </>
      )}
    >
      <p className="github-link-copy">{tr("githubattach.dialogBody")}</p>
      <TextInput
        type="url"
        placeholder={tr("githubattach.urlPlaceholder")}
        value={url}
        onChange={(event) => { setUrl(event.target.value); setError(""); }}
        onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === "Enter") void submit(); }}
        aria-label={tr("githubattach.urlLabel")}
      />
      {error && <div className="github-link-error" role="alert">{error}</div>}
    </Dialog>
  );
}
