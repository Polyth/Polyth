import { useEffect, useRef, useState } from "react";
import type { OpenCodeRuntimePolicyDto, OpenCodeRuntimePolicyStateDto } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
import { EmptyState, ErrorState, NumberField, Row, SaveBar, Section, Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { OPENCODE_MAX_IDLE_TTL_MINUTES, OPENCODE_MAX_WARM_WORKSPACES, parseOpenCodeRuntimePolicy } from "../src/runtimePolicy.ts";

const api = createApiTransport();

export default function OpenCodeWarmSettings() {
  const mounted = useRef(false);
  const [snapshot, setSnapshot] = useState<OpenCodeRuntimePolicyStateDto>();
  const [draft, setDraft] = useState<OpenCodeRuntimePolicyDto>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  useEffect(() => {
    mounted.current = true;
    let current = true;
    setLoading(true);
    setError("");
    setSaved(false);
    void api.get<OpenCodeRuntimePolicyStateDto>("/api/opencode/runtime-policy")
      .then((value) => {
        if (!current) return;
        const settings = parseOpenCodeRuntimePolicy(value.settings);
        setSnapshot({ revision: value.revision, settings });
        setDraft(settings);
      })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : tr("opencode.warm.loadError")); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; mounted.current = false; };
  }, [loadVersion]);
  const update = (patch: Partial<OpenCodeRuntimePolicyDto>) => {
    setSaved(false);
    setDraft((value) => value ? { ...value, ...patch } : value);
  };
  const save = async () => {
    if (!snapshot || !draft || busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const settings = parseOpenCodeRuntimePolicy(draft);
      const value = await api.put<OpenCodeRuntimePolicyStateDto>("/api/opencode/runtime-policy", { settings, expectedRevision: snapshot.revision });
      if (!mounted.current) return;
      setSnapshot(value);
      setDraft(value.settings);
      setSaved(true);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : tr("opencode.warm.saveError"));
    } finally { if (mounted.current) setBusy(false); }
  };
  const dirty = Boolean(snapshot && draft && (draft.mode !== snapshot.settings.mode
    || draft.idleTtlMinutes !== snapshot.settings.idleTtlMinutes || draft.maxWarmWorkspaces !== snapshot.settings.maxWarmWorkspaces));
  const policyHint = !draft ? "" : draft.mode === "default"
    ? tr("opencode.warm.hintDefault")
    : draft.mode === "keep-warm" ? tr("opencode.warm.hintKeepWarm")
      : tr("opencode.warm.hintOff");
  const reset = () => { if (snapshot) setDraft(snapshot.settings); };
  return <div className="pkg-opencode-warm" data-settings-item="opencode.runtime-policy" aria-busy={loading || busy}>
    <Section title={tr("opencode.warm.sectionTitle")} hint={tr("opencode.warm.sectionHint")}>
      {loading ? <EmptyState busy compact title={tr("opencode.warm.loading")} />
        : error && !draft ? <ErrorState compact title={tr("opencode.warm.loadTitle")} error={error} onRetry={() => setLoadVersion((value) => value + 1)} />
          : draft && <>
            <Row label={tr("opencode.warm.keepReady")} hint={policyHint}>
              <Seg<OpenCodeRuntimePolicyDto["mode"]> label={tr("opencode.warm.keepReady")} value={draft.mode} disabled={busy}
                options={[["default", tr("opencode.warm.modeDefault")], ["keep-warm", tr("opencode.warm.modeCustom")], ["off", tr("opencode.warm.modeOff")]]} onChange={(value) => update({ mode: value })} />
            </Row>
            <Row label={tr("opencode.warm.idleTime")} hint={draft.mode === "keep-warm" ? tr("opencode.warm.idleTimeHintKeepWarm") : tr("opencode.warm.idleTimeHintCustomOnly")} disabled={draft.mode !== "keep-warm"}>
              <NumberField label={tr("opencode.warm.idleTime")} unit={tr("opencode.warm.idleUnit")} min={1} max={OPENCODE_MAX_IDLE_TTL_MINUTES} value={draft.idleTtlMinutes}
                disabled={draft.mode !== "keep-warm" || busy} onCommit={(value) => update({ idleTtlMinutes: value })} />
            </Row>
            <Row label={tr("opencode.warm.mostReady")} hint={draft.mode === "off" ? tr("opencode.warm.mostReadyHintOff") : tr("opencode.warm.mostReadyHint")} disabled={draft.mode === "off"}>
              <NumberField label={tr("opencode.warm.mostReady")} min={1} max={OPENCODE_MAX_WARM_WORKSPACES} value={draft.maxWarmWorkspaces}
                disabled={draft.mode === "off" || busy} onCommit={(value) => update({ maxWarmWorkspaces: value })} />
            </Row>
            <SaveBar dirty={dirty} saving={busy} status={error ? "error" : saved ? "saved" : "idle"} {...(error ? { error } : {})}
              onDiscard={reset} onSave={() => void save()} />
          </>}
    </Section>
  </div>;
}
