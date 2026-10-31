import { useEffect, useMemo, useRef, useState } from "react";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { ErrorState, PageHead, Row, Section } from "../../../apps/web/src/components/settings/parts.tsx";

const AUTO_SHELL = "auto";

interface ShellSnapshot {
  shell: string;
  autoShell: string;
  effectiveShell: string;
  available: Array<{ path: string; name: string }>;
}

const parseSnapshot = (value: unknown): ShellSnapshot => {
  const raw = (value ?? {}) as Partial<ShellSnapshot>;
  return {
    shell: typeof raw.shell === "string" ? raw.shell : AUTO_SHELL,
    autoShell: typeof raw.autoShell === "string" ? raw.autoShell : "",
    effectiveShell: typeof raw.effectiveShell === "string" ? raw.effectiveShell : "",
    available: Array.isArray(raw.available)
      ? raw.available.filter((option): option is { path: string; name: string } =>
        typeof option?.path === "string" && typeof option?.name === "string")
      : [],
  };
};

export default function TerminalSettingsPage({ host }: { host: WebPackageHost }) {
  const { Select } = host.ui.components;
  const t = host.ui.locale.translate;
  const api = useMemo(() => createApiTransport(), []);
  const mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<ShellSnapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setError(null);
    void api.get<unknown>("/api/terminals/shell")
      .then((result) => { if (mounted.current) setSnapshot(parseSnapshot(result)); })
      .catch((cause: unknown) => { if (mounted.current) setError(cause); });
  };

  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; };
  }, []);

  const choose = (shell: string) => {
    if (!snapshot || busy || shell === snapshot.shell) return;
    const previous = snapshot;
    setSnapshot({ ...snapshot, shell });
    setBusy(true);
    setSaveError(null);
    void api.put<unknown>("/api/terminals/shell", { shell })
      .then((result) => { if (mounted.current) setSnapshot(parseSnapshot(result)); })
      .catch((cause: unknown) => {
        if (!mounted.current) return;
        setSnapshot(previous);
        setSaveError(host.errors.friendly(t("terminalsettings.saveShell"), cause));
      })
      .finally(() => { if (mounted.current) setBusy(false); });
  };

  if (error) {
    return (
      <section className="terminal-settings">
        <PageHead blurb={t("terminalsettings.blurb")} />
        <ErrorState title={t("terminalsettings.loadFailed")} error={error} onRetry={load} />
      </section>
    );
  }

  const stale = snapshot !== null && snapshot.shell !== AUTO_SHELL
    && !snapshot.available.some((option) => option.path === snapshot.shell);
  const autoName = snapshot?.autoShell.split(/[\\/]/).pop() ?? "";
  const options = snapshot
    ? [
      { value: AUTO_SHELL, label: autoName ? t("terminalsettings.autoWithShell", { shell: autoName }) : t("terminalsettings.auto") },
      ...snapshot.available.map((option) => ({ value: option.path, label: `${option.name} — ${option.path}` })),
      ...(stale ? [{ value: snapshot.shell, label: t("terminalsettings.missingShell", { shell: snapshot.shell }) }] : []),
    ]
    : [{ value: AUTO_SHELL, label: t("terminalsettings.auto") }];

  return (
    <section className="terminal-settings">
      <PageHead blurb={t("terminalsettings.blurb")} />
      <Section title={t("terminalsettings.shellSection")}>
        <Row label={t("terminalsettings.shell")} hint={t("terminalsettings.shellHint")} itemId="terminal.shell">
          <Select
            label={t("terminalsettings.shell")}
            ariaLabel={t("terminalsettings.shell")}
            value={snapshot?.shell ?? AUTO_SHELL}
            disabled={!snapshot || busy}
            options={options}
            onChange={(value: unknown) => choose(String(value))}
          />
        </Row>
        {stale && <p className="set-row-hint" role="status">{t("terminalsettings.staleShell", { shell: snapshot.shell })}</p>}
        {saveError && <p className="set-row-hint" role="alert">{saveError}</p>}
      </Section>
    </section>
  );
}
