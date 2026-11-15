import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, Icon, SearchIcon, Skeleton, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { ErrorState } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { ModelOption, ModelOptionsResponse } from "../src/contracts.ts";
import { loadModels } from "./client.ts";
import { formatContext, groupModels } from "./helpers.ts";
import { harnessLabel } from "./Meter.tsx";

/** Model chooser shared by a role's chain and the never-delegate list. */
export default function ModelPicker({ title, disabledReasons, onPick, onClose }: {
  title: string;
  /** model key → why it cannot be picked. */
  disabledReasons: ReadonlyMap<string, string>;
  onPick: (model: ModelOption) => void;
  onClose: () => void;
}) {
  const [response, setResponse] = useState<ModelOptionsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const load = () => {
    setError(null);
    loadModels().then(setResponse, setError);
  };
  useEffect(load, []);

  const groups = useMemo(
    () => groupModels(response?.models ?? [], query, harnessLabel, { starred: tr("orchestration.picker.starred"), recent: tr("orchestration.picker.recent") }),
    [response, query],
  );
  const flat = useMemo(() => groups.flatMap((group) => group.models.map((model) => ({ group: group.id, model }))), [groups]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-active=true]")?.scrollIntoView?.({ block: "nearest" });
  }, [active, flat.length]);

  const pick = (model: ModelOption) => {
    if (disabledReasons.has(model.key)) return;
    onPick(model);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      const entry = flat[active];
      if (entry) { event.preventDefault(); pick(entry.model); }
    }
  };

  let index = -1;
  return (
    <Dialog title={title} onClose={onClose} size="md" className="orch-picker-dialog" initialFocus=".orch-picker-search">
      <div className="orch-picker" onKeyDown={onKeyDown}>
        <div className="orch-picker-search-wrap">
          <Icon icon={SearchIcon} size="sm" />
          <TextInput
            className="orch-picker-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr("orchestration.picker.search")}
            aria-label={tr("orchestration.picker.search")}
            role="combobox"
            aria-expanded="true"
            aria-controls="orch-picker-list"
            autoFocus
          />
        </div>
        {error ? (
          <ErrorState title={tr("orchestration.picker.loadError")} error={error} onRetry={load} compact />
        ) : !response ? (
          <div className="orch-picker-loading" aria-hidden="true">
            {[0, 1, 2, 3].map((n) => <Skeleton key={n} shape="block" height={44} />)}
          </div>
        ) : flat.length === 0 ? (
          <p className="orch-picker-empty">{tr("orchestration.picker.none")}</p>
        ) : (
          <div id="orch-picker-list" className="orch-picker-list" role="listbox" ref={listRef}>
            {groups.map((group) => (
              <div key={group.id} className="orch-picker-group" role="group" aria-label={group.title}>
                <h4 className="orch-picker-group-title">{group.title}</h4>
                {group.models.map((model) => {
                  index += 1;
                  const at = index;
                  const reason = disabledReasons.get(model.key);
                  return (
                    <button
                      key={`${group.id}:${model.key}`}
                      type="button"
                      role="option"
                      aria-selected={at === active}
                      aria-disabled={reason ? true : undefined}
                      data-active={at === active ? "true" : undefined}
                      data-muted={!model.available || reason ? "true" : undefined}
                      className="orch-picker-option"
                      onMouseMove={() => setActive(at)}
                      onClick={() => pick(model)}
                    >
                      <span className="orch-picker-main">
                        <strong>
                          {model.favorite && <><span className="orch-star" aria-hidden="true">★</span><span className="sr-only">{tr("orchestration.now.favourite")} </span></>}
                          {model.name}
                        </strong>
                        {model.runs && <em>{model.runs}</em>}
                      </span>
                      <span className="orch-picker-sub">{[model.providerName ?? model.providerID, harnessLabel(model.harnessId)].join(" · ")}</span>
                      <span className="orch-picker-chips">
                        {reason && <span className="orch-chip orch-chip--neutral">{reason}</span>}
                        {!model.available && <span className="orch-chip orch-chip--neutral">{tr("orchestration.status.unavailable")}</span>}
                        {model.vision && <span className="orch-chip">{tr("orchestration.picker.vision")}</span>}
                        {model.context ? <span className="orch-chip">{tr("orchestration.picker.context", { size: formatContext(model.context) })}</span> : null}
                        {model.turns > 0 && <span className="orch-chip">{tr("orchestration.now.turns", { count: model.turns })}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {response.catalogUnavailable && <p className="orch-hint">{tr("orchestration.picker.catalogUnavailable")}</p>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
