import { useId, useRef, useState, type DragEvent } from "react";
import type { PackageForkStrategy } from "@polyth/contracts";
import { FormField } from "../../../apps/web/src/components/settings/parts.tsx";
import { Button, Checkbox, Dialog, Icon, Select, TabPanel, Tabs, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { isImeComposing } from "@polyth/web-sdk";
import { FileIcon, UploadIcon } from "../../../apps/web/src/components/ui/icons.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { describeInstallSource, isSupportedInstallSource } from "../src/installSourceContract.ts";
import { formatBytes, MAX_UPLOAD_BYTES } from "./pluginTaxonomy.ts";

export interface SourceInstallOptions {
  fork?: { strategy: PackageForkStrategy };
  autoUpdate?: boolean;
}

type InstallMode = "file" | "link";

const hasFiles = (event: DragEvent<HTMLElement>) => [...(event.dataTransfer?.types ?? [])].includes("Files");

/** Adding a package is one task with two sources: a built archive (dropped
 *  anywhere on the dialog or picked) or a link to an archive or a forge
 *  repository. Everything the host accepts is decided by the shared
 *  `installSourceContract`, so Install cannot disagree with what the server
 *  will actually stage. A failed install keeps the file or link for a retry;
 *  submissions are blocked while one is in flight. */
export function PluginInstallDialog({
  initialFile = null,
  onClose,
  onInstallSource,
  onInstallArchive,
}: {
  /** A ZIP the person already dropped on the page. */
  initialFile?: File | null;
  onClose: () => void;
  onInstallSource: (source: string, options: SourceInstallOptions) => Promise<unknown>;
  onInstallArchive: (archive: string, filename: string) => Promise<unknown>;
}) {
  const tabsId = useId();
  const [mode, setMode] = useState<InstallMode>("file");
  const [source, setSource] = useState("");
  const [file, setFile] = useState<File | null>(initialFile);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState("");
  const [working, setWorking] = useState(false);
  const [asFork, setAsFork] = useState(false);
  const [forkStrategy, setForkStrategy] = useState<PackageForkStrategy>("rebase");
  const [autoUpdate, setAutoUpdate] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);

  const described = describeInstallSource(source);
  const sourceValid = isSupportedInstallSource(source);
  const resolved = described.kind === "repository" && described.archiveUrl ? described : null;
  const githubRepository = resolved?.archiveUrl?.startsWith("https://codeload.github.com/");
  const ready = mode === "file" ? file !== null : sourceValid;

  const chooseFile = (candidate: File | null | undefined) => {
    if (working || !candidate) return;
    setLocalError("");
    if (!/\.zip$/i.test(candidate.name)) {
      setLocalError(tr("packages.plugins.chooseZipArchive"));
      return;
    }
    if (candidate.size > MAX_UPLOAD_BYTES) {
      setLocalError(tr("packages.plugins.archiveTooLarge", { size: formatBytes(MAX_UPLOAD_BYTES) }));
      return;
    }
    setFile(candidate);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (!dragging) setDragging(true);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    setMode("file");
    chooseFile(event.dataTransfer?.files?.[0]);
  };

  const installArchive = async () => {
    if (!file) return;
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let offset = 0; offset < buffer.length; offset += chunk) {
      binary += String.fromCharCode(...buffer.subarray(offset, offset + chunk));
    }
    await onInstallArchive(btoa(binary), file.name);
    setFile(null);
    if (picker.current) picker.current.value = "";
  };

  const installSource = async () => {
    await onInstallSource(source.trim(), {
      ...(resolved && asFork ? { fork: { strategy: forkStrategy } } : {}),
      autoUpdate,
    });
    setSource("");
  };

  const install = async () => {
    if (!ready || working) return;
    setLocalError("");
    setWorking(true);
    try {
      await (mode === "file" ? installArchive() : installSource());
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog
      title={tr("packages.plugins.addPackage")}
      size="md"
      className="plugin-install-dialog"
      onClose={() => { if (!working) onClose(); }}
      footer={(
        <>
          <Button variant="ghost" disabled={working} onClick={onClose}>{tr("common.cancel")}</Button>
          <Button variant="primary" busy={working} disabled={!ready} onClick={() => void install()}>
            {mode === "link" && resolved ? tr("packages.plugins.installFromRepository") : tr("packages.plugins.install")}
          </Button>
        </>
      )}
    >
      <div
        className={`plugin-install${dragging ? " is-dragging" : ""}`}
        data-settings-item="plugins.install"
        onDragOver={onDragOver}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={onDrop}
      >
        <Tabs
          size="sm"
          className="plugin-install-tabs"
          idBase={tabsId}
          label={tr("packages.plugins.addPackage")}
          value={mode}
          tabs={[
            { id: "file", label: tr("packages.plugins.fromFile"), disabled: working },
            { id: "link", label: tr("packages.plugins.fromLink"), disabled: working },
          ]}
          onChange={(next) => { setLocalError(""); setMode(next === "link" ? "link" : "file"); }}
        />
        <TabPanel idBase={tabsId} tabId={mode} active className="plugin-install-panel">
          {mode === "file" ? (
            <label className={`plugin-drop${dragging ? " is-dragging" : ""}${file ? " has-file" : ""}`}>
              <input
                ref={picker}
                type="file"
                disabled={working}
                accept=".zip,application/zip"
                className="plugin-drop-input"
                onChange={(event) => chooseFile(event.target.files?.[0])}
              />
              <span className="plugin-drop-icon" aria-hidden="true"><Icon icon={file ? FileIcon : UploadIcon} size="lg" /></span>
              {file ? (
                <span className="plugin-drop-copy">
                  <strong>{file.name}</strong>
                  <small>{formatBytes(file.size)}</small>
                </span>
              ) : (
                <span className="plugin-drop-copy">
                  <strong>{tr("packages.plugins.dropArchive")}</strong>
                  <small>{tr("packages.plugins.dropArchiveHint", { size: formatBytes(MAX_UPLOAD_BYTES) })}</small>
                </span>
              )}
              <Button
                size="sm"
                variant="quiet"
                disabled={working}
                onClick={(event) => { event.preventDefault(); picker.current?.click(); }}
              >
                {file ? tr("packages.plugins.chooseAnotherFile") : tr("packages.plugins.chooseFile")}
              </Button>
            </label>
          ) : (
            <div className="plugin-install-link">
              <FormField label={tr("packages.plugins.linkLabel")} hint={tr("packages.plugins.linkHint")}>
                {(field) => (
                  <TextInput
                    {...field}
                    disabled={working}
                    value={source}
                    placeholder={tr("packages.plugins.sourceHint")}
                    aria-invalid={source.length > 0 && !sourceValid ? true : undefined}
                    onChange={(event) => setSource(event.target.value)}
                    onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === "Enter" && sourceValid) { event.preventDefault(); void install(); } }}
                  />
                )}
              </FormField>
              {resolved && (
                <p className="plugin-install-resolved" aria-live="polite">
                  {githubRepository
                    ? tr("packages.plugins.githubRepositoryWillDownload", { repository: resolved.label })
                    : tr("packages.plugins.repositoryWillDownload", { repository: resolved.label, url: resolved.archiveUrl ?? "" })}
                </p>
              )}
              {sourceValid && (
                <div className="plugin-install-options">
                  {resolved && (
                    <Checkbox
                      checked={asFork}
                      disabled={working}
                      onChange={setAsFork}
                      label={tr("packages.plugins.installAsFork")}
                      description={tr("packages.plugins.installAsForkHint")}
                    />
                  )}
                  {resolved && asFork && (
                    <div className="plugin-install-strategy">
                      <span>{tr("packages.plugins.forkStrategy")}</span>
                      <Select
                        label={tr("packages.plugins.forkStrategy")}
                        value={forkStrategy}
                        disabled={working}
                        options={[
                          { value: "rebase", label: tr("packages.plugins.forkStrategyRebase"), detail: tr("packages.plugins.forkStrategyRebaseHint") },
                          { value: "merge", label: tr("packages.plugins.forkStrategyMerge"), detail: tr("packages.plugins.forkStrategyMergeHint") },
                        ]}
                        onChange={(value) => setForkStrategy(value === "merge" ? "merge" : "rebase")}
                      />
                    </div>
                  )}
                  <Checkbox
                    checked={autoUpdate}
                    disabled={working}
                    onChange={setAutoUpdate}
                    label={tr("packages.plugins.autoUpdate")}
                    description={tr("packages.plugins.autoUpdateHint")}
                  />
                </div>
              )}
            </div>
          )}
        </TabPanel>
        {localError && <div className="form-error plugin-install-error" role="alert">{localError}</div>}
      </div>
    </Dialog>
  );
}
