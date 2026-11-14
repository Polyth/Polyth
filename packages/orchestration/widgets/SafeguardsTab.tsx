import { useEffect, useMemo, useState } from "react";
import { Button, CloseIcon, IconButton, PlusIcon } from "../../../apps/web/src/components/ui/index.ts";
import { ItemList, ItemRow, ResetLink, Row, Section, Seg, SizeStepper, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { POLICY_LIMITS, type ModelOption, type RoutingPolicy } from "../src/contracts.ts";
import { loadModels } from "./client.ts";
import { withQuotaCeiling } from "./helpers.ts";
import ModelPicker from "./ModelPicker.tsx";
import { harnessLabel } from "./Meter.tsx";

/** Readable pieces of a `harness::provider/model` key when the catalog does not know it. */
function splitKey(key: string): { harness: string; provider: string; model: string } {
  const [harness = "", rest = key] = key.split("::", 2) as [string?, string?];
  const slash = rest.indexOf("/");
  return slash < 0 ? { harness, provider: "", model: rest } : { harness, provider: rest.slice(0, slash), model: rest.slice(slash + 1) };
}

export default function SafeguardsTab({ draft, setDraft, onReset, busy }: {
  draft: RoutingPolicy;
  setDraft: (next: RoutingPolicy) => void;
  onReset: () => void;
  busy: boolean;
}) {
  const [picker, setPicker] = useState(false);
  const [known, setKnown] = useState<ReadonlyMap<string, ModelOption>>(() => new Map());
  useEffect(() => {
    let live = true;
    loadModels().then((r) => { if (live) setKnown(new Map(r.models.map((m) => [m.key, m]))); }, () => undefined);
    return () => { live = false; };
  }, []);
  const disabled = useMemo(() => new Map(draft.excluded.map((key) => [key, tr("orchestration.picker.onNever")])), [draft.excluded]);
  const overOn = draft.overPaceCeiling !== null;
  const add = (model: ModelOption) => {
    if (draft.excluded.length < POLICY_LIMITS.excluded && !draft.excluded.includes(model.key)) {
      setDraft({ ...draft, excluded: [...draft.excluded, model.key] });
    }
    setPicker(false);
  };
  return (
    <div className="orch-safeguards">
      <Section title={tr("orchestration.safe.quotaSection")} hint={tr("orchestration.safe.quotaHint")} itemId="orchestration.quota-ceiling">
        <Row label={tr("orchestration.safe.quota")}>
          <SizeStepper
            label={tr("orchestration.safe.quota")}
            value={draft.quotaCeiling}
            min={POLICY_LIMITS.quotaCeiling.min}
            max={POLICY_LIMITS.quotaCeiling.max}
            step={5}
            unit="%"
            onChange={(value) => setDraft(withQuotaCeiling(draft, value))}
          />
        </Row>
        <Row label={tr("orchestration.safe.overPace")} hint={tr("orchestration.safe.overPaceHint")} itemId="orchestration.over-pace">
          <div className="orch-over-pace">
            <Toggle
              on={overOn}
              label={tr("orchestration.safe.overPace")}
              onChange={(on) => setDraft({ ...draft, overPaceCeiling: on ? Math.min(70, draft.quotaCeiling) : null })}
            />
            {overOn && (
              <SizeStepper
                label={tr("orchestration.safe.overPaceLevel")}
                value={Math.min(draft.overPaceCeiling ?? draft.quotaCeiling, draft.quotaCeiling)}
                min={POLICY_LIMITS.overPaceCeiling.min}
                max={Math.max(POLICY_LIMITS.overPaceCeiling.min, draft.quotaCeiling)}
                step={5}
                unit="%"
                onChange={(value) => setDraft({ ...draft, overPaceCeiling: value })}
              />
            )}
          </div>
        </Row>
      </Section>
      <Section title={tr("orchestration.safe.exhausted")} itemId="orchestration.exhausted">
        <div className="orch-seg">
          <Seg
            label={tr("orchestration.safe.exhausted")}
            value={draft.whenExhausted}
            options={[["shortlist", tr("orchestration.safe.exhaustedList")], ["direct", tr("orchestration.safe.exhaustedDirect")]]}
            onChange={(value) => setDraft({ ...draft, whenExhausted: value })}
          />
        </div>
        <p className="orch-hint">
          {draft.whenExhausted === "direct" ? tr("orchestration.safe.exhaustedDirectHint") : tr("orchestration.safe.exhaustedListHint")}
        </p>
      </Section>
      <Section title={tr("orchestration.safe.parallelSection")} hint={tr("orchestration.safe.parallelHint")} itemId="orchestration.max-children">
        <Row label={tr("orchestration.safe.parallel")}>
          <SizeStepper
            label={tr("orchestration.safe.parallel")}
            value={draft.maxChildren}
            min={POLICY_LIMITS.maxChildren.min}
            max={POLICY_LIMITS.maxChildren.max}
            unit=""
            onChange={(value) => setDraft({ ...draft, maxChildren: value })}
          />
        </Row>
      </Section>
      <Section
        title={tr("orchestration.safe.excluded")}
        hint={tr("orchestration.safe.excludedHint")}
        itemId="orchestration.excluded"
        action={(
          <Button iconStart={PlusIcon} size="sm" onClick={() => setPicker(true)} disabled={draft.excluded.length >= POLICY_LIMITS.excluded}>
            {tr("orchestration.safe.excludedAdd")}
          </Button>
        )}
      >
        {draft.excluded.length === 0 ? (
          <p className="orch-muted">{tr("orchestration.safe.excludedEmpty")}</p>
        ) : (
          <ItemList>
            {draft.excluded.map((key) => {
              const model = known.get(key);
              const parts = splitKey(key);
              const name = model?.name ?? parts.model;
              return (
                <ItemRow
                  key={key}
                  icon={<span className="orch-rank" aria-hidden="true">⊘</span>}
                  title={name}
                  meta={<span className="orch-meta">{[model?.providerName ?? model?.providerID ?? parts.provider, harnessLabel(model?.harnessId ?? parts.harness)].filter(Boolean).join(" · ")}</span>}
                  trailing={(
                    <IconButton
                      icon={CloseIcon}
                      label={tr("orchestration.safe.excludedRemove", { name })}
                      size="sm"
                      onClick={() => setDraft({ ...draft, excluded: draft.excluded.filter((k) => k !== key) })}
                    />
                  )}
                />
              );
            })}
          </ItemList>
        )}
      </Section>
      <ResetLink label={tr("orchestration.safe.reset")} onClick={onReset} disabled={busy} />
      {picker && (
        <ModelPicker title={tr("orchestration.picker.titleExclude")} disabledReasons={disabled} onPick={add} onClose={() => setPicker(false)} />
      )}
    </div>
  );
}
