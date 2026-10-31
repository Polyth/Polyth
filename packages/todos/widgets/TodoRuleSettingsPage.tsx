import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { EmptyState, ErrorState, PageHead, Row, SaveBar, Section, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { todoStrings } from "./strings.ts";
import {
  DEFAULT_TODO_RULE,
  TODO_RULE_MAX_CHARS,
  parseTodoRuleSettings,
  todoRuleSection,
  type TodoRuleSettings,
} from "@polyth/todos/rule";

interface SettingsSnapshot {
  revision: number;
  settings: TodoRuleSettings;
  active: boolean;
}

const api = createApiTransport();
const PATH = "/api/todos/rule";

export default function TodoRuleSettingsPage({ host }: { host: WebPackageHost }) {
  const t = todoStrings(host.ui.locale.get());
  const mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<TodoRuleSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    void api.get<SettingsSnapshot>(PATH)
      .then((value) => {
        if (!mounted.current) return;
        const settings = parseTodoRuleSettings(value.settings);
        setSnapshot({ revision: value.revision, settings, active: value.active });
        setDraft(settings);
      })
      .catch((cause) => {
        if (mounted.current) setLoadError(cause ?? new Error(t.settingsUnavailable));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; };
  }, [load]);

  const update = (patch: Partial<TodoRuleSettings>) => {
    setSaved(false);
    setDraft((current) => current ? { ...current, ...patch } : current);
  };

  const save = async () => {
    if (!draft || !snapshot || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api.put<SettingsSnapshot>(PATH, {
        settings: parseTodoRuleSettings(draft),
        expectedRevision: snapshot.revision,
      });
      if (!mounted.current) return;
      const settings = parseTodoRuleSettings(result.settings);
      setSnapshot({ revision: result.revision, settings, active: result.active });
      setDraft(settings);
      setSaved(true);
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && cause.status === 409) {
        setError(t.settingsConflict);
      } else if (cause instanceof ApiError && cause.status === 403) {
        setError(t.settingsOwnerOnly);
      } else {
        setError(host.errors.friendly(t.settingsSaveFailed, cause));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const { Button, Textarea } = host.ui.components;
  if (loading && !snapshot) {
    return (
      <section className="todos-settings">
        <PageHead blurb={t.settingsPageBlurb} />
        <EmptyState title={t.settingsLoading} busy />
      </section>
    );
  }
  if (!draft || !snapshot) {
    return (
      <section className="todos-settings">
        <PageHead blurb={t.settingsPageBlurb} />
        <ErrorState
          title={t.settingsUnavailable}
          error={loadError ?? new Error(t.settingsUnavailableBody)}
          onRetry={load}
        />
      </section>
    );
  }

  const dirty = draft.enabled !== snapshot.settings.enabled || draft.text.trim() !== snapshot.settings.text;
  const tooLong = draft.text.length > TODO_RULE_MAX_CHARS;
  const preview = todoRuleSection({ enabled: true, text: draft.text });

  return (
    <section className="todos-settings">
      <PageHead blurb={t.settingsPageBlurb} />

      <Section title={t.sectionAgentRule}>
        <Row
          label={t.requireLabel}
          hint={t.requireHint}
          itemId="todos.rule-enabled"
        >
          <Toggle on={draft.enabled} disabled={busy} onChange={(enabled) => update({ enabled })} label={t.requireLabel} />
        </Row>

        <Row
          layout="stacked"
          label={t.ruleTextLabel}
          hint={t.ruleTextHint}
          itemId="todos.rule-text"
        >
          <div className="todos-settings__rule">
            <Textarea
              value={draft.text}
              disabled={busy}
              rows={5}
              placeholder={DEFAULT_TODO_RULE}
              aria-label={t.ruleTextLabel}
              onChange={(event: { target: { value: string } }) => update({ text: event.target.value })}
            />
            <div className="todos-settings__rule-meta">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || draft.text.trim() === DEFAULT_TODO_RULE}
                onClick={() => update({ text: DEFAULT_TODO_RULE })}
              >
                {t.restoreDefault}
              </Button>
              <small className={tooLong ? "todos-settings__count todos-settings__count--over" : "todos-settings__count"}>
                {draft.text.length} / {TODO_RULE_MAX_CHARS}
              </small>
            </div>
            <details className="todos-settings__preview">
              <summary>{t.previewSummary}</summary>
              <pre>{preview}</pre>
            </details>
          </div>
        </Row>

        {!snapshot.active && snapshot.settings.enabled ? (
          <div className="todos-settings__hint" role="status">{t.savedNotActive}</div>
        ) : null}

        <SaveBar
          dirty={dirty && !tooLong}
          saving={busy}
          status={error ? "error" : saved ? "saved" : "idle"}
          {...(error ? { error } : {})}
          onSave={() => void save()}
          onDiscard={() => { setDraft(snapshot.settings); setError(null); }}
        />
      </Section>
    </section>
  );
}
