// One-click harness install: a calm, plain-language dialog for people who have
// never opened a terminal, with everything a technical person wants to check
// one disclosure away (machine, exact command, download hosts, live output,
// or running it in the Terminal instead). The server runs the install in the
// background; this only follows it (installs.ts).
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { HarnessInstallDto, HarnessInstallPreviewDto, HarnessSnapshot } from "@polyth/contracts";
import { ApiError, type WebPackageHost } from "@polyth/web-sdk";
import ProviderLogo from "@polyth/models/provider-logo";
import {
  Button, ClockIcon, CloseIcon, Dialog, DownloadIcon, ErrorIcon, ExternalLinkIcon, Icon, IconButton, KeyIcon, Notice,
  SessionIcon, ShieldIcon, Spinner, StopIcon, SuccessIcon, TerminalIcon, VisuallyHidden, WrenchIcon,
} from "../../../apps/web/src/components/ui/index.ts";
import CopyButton from "../../../apps/web/src/components/CopyButton.tsx";
import { displayVersion, harnessTint } from "./presentation.ts";
import {
  failureCopy, formatElapsed, installIsActive, installSteps, machineWords, nextStepAfterInstall, osWords, sourceList, type Translate,
} from "./installPresentation.ts";
import {
  cancelHarnessInstall, consumeInstallRequest, readHarnessInstall, setInstallDialogVisible, startHarnessInstall,
} from "./installs.ts";

type Open = { harnessId: string; harnessName: string };

/** The install dialog and how to open it. `rows`/`checking` are the page's
 *  live view, so the step after a successful install follows Settings' own
 *  re-check (signed in already, sign in, or a little setup). */
export function useHarnessInstall({ host, projectId, rows, checking, canManage, jobs, requested, onSignIn, onTerminal }: {
  host: WebPackageHost;
  projectId: string | null | undefined;
  rows: readonly HarnessSnapshot[];
  checking: ReadonlySet<string>;
  canManage: boolean;
  jobs: ReadonlyMap<string, HarnessInstallDto>;
  requested?: { harnessId: string; seq: number };
  onSignIn: (row: HarnessSnapshot) => void;
  /** Run the same installer in a visible Terminal instead. */
  onTerminal: (row: HarnessSnapshot, command: string) => void;
}) {
  const [open, setOpen] = useState<Open>();
  const show = useCallback((row: Pick<HarnessSnapshot, "identity">) => setOpen({ harnessId: row.identity.id, harnessName: row.identity.name }), []);
  // A notification's "Show"/"Open" asked for this harness's install.
  useEffect(() => {
    if (!requested) return;
    const row = rows.find((candidate) => candidate.identity.id === requested.harnessId);
    if (row) {
      setOpen({ harnessId: row.identity.id, harnessName: row.identity.name });
      consumeInstallRequest(requested.seq);
    }
  }, [requested, rows]);
  const row = open ? rows.find((candidate) => candidate.identity.id === open.harnessId) : undefined;
  const dialog = open ? <InstallDialog
    key={open.harnessId}
    host={host}
    projectId={projectId}
    harnessId={open.harnessId}
    harnessName={open.harnessName}
    row={row}
    checking={checking.has(open.harnessId)}
    canManage={canManage}
    job={jobs.get(open.harnessId)}
    onClose={() => setOpen(undefined)}
    onSignIn={(target) => { setOpen(undefined); onSignIn(target); }}
    onTerminal={(target, command) => { setOpen(undefined); onTerminal(target, command); }}
  /> : null;
  return { open: show, dialog };
}

function InstallDialog({ host, projectId, harnessId, harnessName, row, checking, canManage, job, onClose, onSignIn, onTerminal }: {
  host: WebPackageHost;
  projectId: string | null | undefined;
  harnessId: string;
  harnessName: string;
  row: HarnessSnapshot | undefined;
  checking: boolean;
  canManage: boolean;
  job: HarnessInstallDto | undefined;
  onClose: () => void;
  onSignIn: (row: HarnessSnapshot) => void;
  onTerminal: (row: HarnessSnapshot, command: string) => void;
}) {
  const t: Translate = useCallback((key, values) => host.ui.locale.translate(`harnessruntime.install.${key}`, values), [host]);
  const locale = host.ui.locale.get();
  const [preview, setPreview] = useState<HarnessInstallPreviewDto>();
  const [problem, setProblem] = useState<{ kind: "forbidden" | "unsupported" | "error"; message: string }>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const leadId = useId();
  // Read by the one-time preview request, which must not re-run per render.
  const fallback = useRef({ row, onTerminal });
  fallback.current = { row, onTerminal };

  useEffect(() => {
    setInstallDialogVisible(harnessId, true, projectId);
    return () => setInstallDialogVisible(harnessId, false, projectId);
  }, [harnessId, projectId]);
  useEffect(() => {
    let live = true;
    void readHarnessInstall(harnessId, projectId).then(
      (result) => { if (live) setPreview(result.preview); },
      (cause: unknown) => {
        if (!live) return;
        // A server without background installs: the Terminal still works.
        const { row: current, onTerminal: openTerminal } = fallback.current;
        const installCommand = current?.setup?.installCommand;
        if (cause instanceof ApiError && cause.status === 404 && current && installCommand) {
          openTerminal(current, installCommand);
          return;
        }
        const code = cause instanceof ApiError ? cause.code ?? (cause.status === 403 ? "forbidden" : undefined) : undefined;
        setProblem({ kind: code === "forbidden" ? "forbidden" : code === "unsupported" ? "unsupported" : "error", message: host.errors.friendly(t("action.install"), cause) });
      },
    );
    return () => { live = false; };
  }, [harnessId, host.errors, projectId, t]);
  const active = installIsActive(job);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  // Where the dialog stands now: a fresh preview names the machine for this
  // browser (someone else may have started the install from another device).
  const source = preview ?? job;
  const words = source ? machineWords(source, t) : { on: t("machine.onThisComputer"), title: t("machine.thisComputer") };
  const name = row?.identity.name ?? source?.harnessName ?? harnessName;
  // A success that a later check no longer confirms (the CLI was removed) is
  // history: offer the install again.
  const staleSuccess = job?.phase === "succeeded" && row !== undefined && !row.availability.installed
    && row.availability.checkedAt > (job.finishedAt ?? job.startedAt);
  const phase = job && !staleSuccess ? job.phase : "confirm";

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError("");
    try { await action(); } catch (cause) { setActionError(host.errors.friendly(t("action.install"), cause)); } finally { setBusy(false); }
  };
  const install = () => void run(() => startHarnessInstall(harnessId, projectId));
  const stop = () => void run(() => cancelHarnessInstall(harnessId, projectId));

  const title = phase === "confirm" ? t("title.confirm", { name })
    : phase === "verifying" ? t("title.running", { name })
      : t(`title.${phase}`, { name });
  const next = phase === "succeeded" ? nextStepAfterInstall(row, checking) : "none";
  const failure = job?.phase === "failed" ? failureCopy(job, words, t, locale) : undefined;
  const elapsed = job && active ? formatElapsed(now - job.startedAt) : "";
  const lead = phase === "confirm" ? (preview ? t("lead.confirm", { name, onMachine: words.on }) : "")
    : phase === "queued" ? t("lead.queued", { onMachine: words.on })
      : phase === "running" || phase === "verifying" ? t("lead.running")
        : phase === "succeeded" ? (job?.result?.version ? t("lead.succeededVersion", { version: displayVersion(job.result.version) ?? job.result.version, onMachine: words.on }) : t("lead.succeeded", { name, onMachine: words.on }))
          : phase === "cancelled" ? t("lead.cancelled")
            : failure?.summary ?? "";
  const mark = phase === "succeeded" ? "success" : phase === "failed" ? "error" : phase === "cancelled" ? "stopped" : active ? "busy" : "idle";

  const guide = (row?.setup?.setupUrl ?? preview?.setupUrl)
    ? <a className="ui-btn ui-btn--ghost ui-btn--sm pkg-harnesses-install-guide" href={row?.setup?.setupUrl ?? preview?.setupUrl} target="_blank" rel="noreferrer">{t("action.guide")}<Icon icon={ExternalLinkIcon} size="sm" /></a>
    : null;
  const footer: ReactNode = problem
    ? <>{guide}<Button size="sm" variant="primary" onClick={onClose}>{t("action.close")}</Button></>
    : phase === "confirm" ? <>
      <Button size="sm" variant="ghost" onClick={onClose}>{t("action.cancel")}</Button>
      <Button size="sm" variant="primary" iconStart={DownloadIcon} busy={busy} disabled={!preview || !canManage} onClick={install}>{t("action.install")}</Button>
    </>
      : active ? <>
        {phase !== "verifying" && <Button size="sm" variant="ghost" busy={busy} onClick={stop}>{t("action.stop")}</Button>}
        <Button size="sm" variant="primary" onClick={onClose}>{t("action.hide")}</Button>
      </>
        : phase === "succeeded" ? next === "sign-in" && row ? <>
          <Button size="sm" variant="ghost" onClick={onClose}>{t("action.later")}</Button>
          <Button size="sm" variant="primary" iconStart={KeyIcon} onClick={() => onSignIn(row)}>{t("action.signIn")}</Button>
        </> : <Button size="sm" variant="primary" disabled={next === "checking"} onClick={onClose}>{t("action.done")}</Button>
          : <>
            {guide}
            <Button size="sm" variant="ghost" onClick={onClose}>{t("action.close")}</Button>
            <Button size="sm" variant="primary" iconStart={DownloadIcon} busy={busy} disabled={!canManage} onClick={install}>{t("action.tryAgain")}</Button>
          </>;

  return <Dialog title={title} onClose={onClose} hideHeader size="md" className="pkg-harnesses-install-dialog" ariaDescribedBy={leadId} footer={<div className="pkg-harnesses-install-actions">{footer}</div>}>
    <div className="pkg-harnesses pkg-harnesses-install" data-phase={phase}>
      <header className="pkg-harnesses-install-hero">
        <span className="pkg-harnesses-install-mark" data-mark={mark}>
          <span className="pkg-harnesses-logo-tile pkg-harnesses-logo-tile--lg" data-tinted={row?.identity.color || row?.identity.accountLabel ? "true" : undefined} style={row ? harnessTint(row.identity) : undefined}>
            <ProviderLogo providerID={harnessId} providerName={row?.identity.defaultName ?? name} size="regular" />
          </span>
          {mark !== "idle" && <span className="pkg-harnesses-install-badge" aria-hidden="true">
            {mark === "busy" ? <Spinner size="sm" /> : <Icon icon={mark === "success" ? SuccessIcon : mark === "error" ? ErrorIcon : StopIcon} size="sm" />}
          </span>}
        </span>
        <div className="pkg-harnesses-install-heading">
          <h2>{title}</h2>
          <p id={leadId}>{problem ? "" : lead || (!preview ? t("loading") : "")}</p>
        </div>
        <IconButton icon={CloseIcon} label={t("action.close")} onClick={onClose} />
      </header>
      {/* One live region for the whole dialog, so the start and the end of an
          install are announced, not only the minutes in between. */}
      <VisuallyHidden><span role="status" aria-live="polite">{phase === "confirm" ? "" : `${title}. ${lead}`}</span></VisuallyHidden>

      {problem && <Notice tone={problem.kind === "error" ? "error" : "info"} role={problem.kind === "error" ? "alert" : undefined}>
        {problem.kind === "forbidden" ? t("notAllowed", { name, onMachine: words.on })
          : problem.kind === "unsupported" ? t("noInstaller", { name, onMachine: words.on })
            : problem.message}
      </Notice>}

      {!problem && phase === "confirm" && preview && <ul className="pkg-harnesses-install-facts">
        <li><Icon icon={ShieldIcon} size="md" /><span><strong>{t("fact.source.title")}</strong><small>{preview.sources.length ? t("fact.source.body", { sources: sourceList(preview.sources, locale) }) : t("fact.source.bodyUnknown", { name })}</small></span></li>
        <li><Icon icon={SessionIcon} size="md" /><span><strong>{t("fact.user.title")}</strong><small>{preview.machine.kind === "remote" ? t("fact.user.bodyRemote", { onMachine: words.on }) : t("fact.user.body", { onMachine: words.on })}</small></span></li>
        <li><Icon icon={ClockIcon} size="md" /><span><strong>{t("fact.time.title")}</strong><small>{t("fact.time.body")}</small></span></li>
      </ul>}
      {!problem && phase === "confirm" && !canManage && preview && <Notice>{t("notAllowed", { name, onMachine: words.on })}</Notice>}

      {job && (active || phase === "succeeded") && <ol className="pkg-harnesses-install-steps" aria-label={title}>
        {installSteps(job).map((step) => <li key={step.id} data-state={step.state}>
          <span className="pkg-harnesses-install-step-mark" aria-hidden="true">
            {step.state === "active" ? <Spinner size="sm" /> : step.state === "done" ? <Icon icon={SuccessIcon} size="sm" /> : step.state === "failed" ? <Icon icon={ErrorIcon} size="sm" /> : null}
          </span>
          <span className="pkg-harnesses-install-step-copy">
            <span className="pkg-harnesses-install-step-label">{t(step.id === "install" && phase === "queued" ? "step.waiting" : `step.${step.id}`)}</span>
            {step.id === "install" && step.state === "active" && <>
              {job.activity && <span className="pkg-harnesses-install-activity" title={job.activity}>{job.activity}</span>}
            </>}
          </span>
          {step.id === "install" && elapsed && <span className="pkg-harnesses-install-elapsed"><span aria-hidden="true">{elapsed}</span><VisuallyHidden>{t("elapsed", { time: elapsed })}</VisuallyHidden></span>}
        </li>)}
      </ol>}

      {failure && <div className="pkg-harnesses-install-help" role="alert">
        <p>{failure.hint}</p>
        {failure.quote && <blockquote>{failure.quote}</blockquote>}
      </div>}

      {phase === "succeeded" && next !== "none" && <div className="pkg-harnesses-install-next" data-next={next} role="status">
        {next === "checking" ? <><Spinner size="sm" /><p>{t("next.checking")}</p></>
          : next === "sign-in" ? <><Icon icon={KeyIcon} size="md" /><p><strong>{t("next.signInTitle")}</strong><span>{t("next.signInBody", { name })}</span></p></>
            : next === "ready" ? <><Icon icon={SuccessIcon} size="md" /><p><strong>{t("next.readyTitle")}</strong><span>{t("next.readyBody", { name })}</span></p></>
              : <><Icon icon={WrenchIcon} size="md" /><p><strong>{t("next.setupTitle")}</strong><span>{t("next.setupBody", { name })}</span></p></>}
      </div>}

      {actionError && <Notice tone="error" role="alert">{actionError}</Notice>}

      {source && <Details t={t} preview={source} words={words} job={staleSuccess ? undefined : job} row={row} projectId={projectId} onTerminal={onTerminal} />}
    </div>
  </Dialog>;
}

/** Everything a technical person checks before trusting an installer. */
function Details({ t, preview, words, job, row, projectId, onTerminal }: {
  t: Translate;
  preview: HarnessInstallPreviewDto;
  words: { title: string };
  job: HarnessInstallDto | undefined;
  row: HarnessSnapshot | undefined;
  projectId: string | null | undefined;
  onTerminal: (row: HarnessSnapshot, command: string) => void;
}) {
  const log = useRef<HTMLPreElement>(null);
  const output = job?.output ?? "";
  // Follow the newest line unless the reader scrolled up to read.
  const pinned = useRef(true);
  useEffect(() => {
    const element = log.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [output]);
  const canTerminal = Boolean(row) && !installIsActive(job);
  return <details className="pkg-harnesses-install-details">
    <summary><span>{t("details.summary")}</span></summary>
    <div className="pkg-harnesses-install-details-body">
    <dl className="pkg-harnesses-install-facts-list">
      <div><dt>{t("details.machine")}</dt><dd>{words.title}<small>{t("details.shell", { os: osWords(preview, t) })}</small></dd></div>
      {preview.sources.length > 0 && <div><dt>{t("details.sources")}</dt><dd className="pkg-harnesses-install-sources">{preview.sources.map((host) => <code key={host}>{host}</code>)}</dd></div>}
    </dl>
    <div className="pkg-harnesses-install-block">
      <span className="pkg-harnesses-install-block-label">{t("details.command")}</span>
      <div className="pkg-harnesses-install-log" data-kind="command">
        <pre>{preview.command}</pre>
        <CopyButton text={preview.command} label={t("action.copyCommand")} />
      </div>
    </div>
    {job && <div className="pkg-harnesses-install-block">
      <span className="pkg-harnesses-install-block-label">{t("details.output")}{job.truncated && <small>{t("details.truncated")}</small>}</span>
      <div className="pkg-harnesses-install-log">
        <pre ref={log} tabIndex={0} onScroll={(event) => {
          const element = event.currentTarget;
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}>{output || t("details.noOutput")}</pre>
        {output && <CopyButton text={output} label={t("action.copyLog")} />}
      </div>
    </div>}
    <div className="pkg-harnesses-install-terminal">
      <p>{projectId ? t("details.terminalHint") : t("details.terminalNeedsProject")}</p>
      <Button size="sm" variant="ghost" iconStart={TerminalIcon} disabled={!projectId || !canTerminal} onClick={() => { if (row) onTerminal(row, preview.command); }}>{t("action.terminal")}</Button>
    </div>
    </div>
  </details>;
}
