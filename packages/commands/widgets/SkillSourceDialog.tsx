import { useState } from "react";
import type { SkillCatalogSourceDto } from "@polyth/contracts/capability-installations";
import { FormField } from "../../../apps/web/src/components/settings/parts.tsx";
import { Button, Dialog, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { skillsApi } from "./skillsApi.ts";

/** Adding a source reads it first, so a mistyped or empty repository is reported
 *  here and never joins the catalog. */
export function SkillSourceDialog({ onClose, onAdded }: {
  onClose: () => void;
  onAdded: (source: SkillCatalogSourceDto) => void | Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState("");
  const submit = async () => {
    if (!url.trim() || working) return;
    setWorking(true);
    setFailure("");
    try {
      await onAdded(await skillsApi.addSource(url.trim()));
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      setWorking(false);
    }
  };
  return (
    <Dialog
      title={tr("settings.skills.source.title")}
      size="sm"
      onClose={() => { if (!working) onClose(); }}
      footer={(
        <>
          <Button variant="ghost" disabled={working} onClick={onClose}>{tr("settings.skillspage.cancel")}</Button>
          <Button variant="primary" busy={working} disabled={!url.trim()} onClick={() => void submit()}>
            {working ? tr("settings.skills.source.adding") : tr("settings.skills.source.add")}
          </Button>
        </>
      )}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <FormField
          label={tr("settings.skills.source.label")}
          hint={tr("settings.skills.source.hint")}
          {...(failure ? { error: failure } : {})}
        >
          {(field) => (
            <TextInput
              {...field}
              autoFocus
              className="inp-mono"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={tr("settings.skills.source.placeholder")}
              value={url}
              disabled={working}
              onChange={(event) => setUrl(event.target.value)}
            />
          )}
        </FormField>
      </form>
    </Dialog>
  );
}
