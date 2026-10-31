// The one marker dialog: add a (possibly new) marker to chats, create a custom
// marker, or edit one. It lives in the shell's floating layer, so it survives
// the chat menu that opened it closing.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Dialog, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  MARKER_COLORS,
  MARKER_ICONS,
  MARKER_LABEL_MAX,
  MARKER_NOTE_MAX,
  resolveMarker,
  type MarkerColor,
  type MarkerIcon,
} from "../src/markers.ts";
import { changeMarkers, createMarker, updateMarker, useDefinitions } from "./client.ts";
import { colorLabel, iconLabel, MarkerGlyph, markerLabel } from "./visuals.tsx";
import type { WebPackageHost } from "@polyth/web-sdk";

export type MarkerDialogRequest =
  | { kind: "apply"; sessionIds: readonly string[] }
  | { kind: "create" }
  | { kind: "edit"; id: string };

let current: MarkerDialogRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export function openMarkerDialog(request: MarkerDialogRequest): void {
  current = request;
  emit();
}

export function closeMarkerDialog(): void {
  current = null;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function MarkerDialogLayer({ host }: { host: WebPackageHost }) {
  const request = useSyncExternalStore(subscribe, () => current, () => null);
  if (!request) return null;
  return <MarkerDialog key={JSON.stringify(request)} host={host} request={request} onClose={closeMarkerDialog} />;
}

function MarkerDialog({ host, request, onClose }: { host: WebPackageHost; request: MarkerDialogRequest; onClose: () => void }) {
  const definitions = useDefinitions();
  const editing = request.kind === "edit" ? definitions.find((marker) => marker.id === request.id) : undefined;
  const [name, setName] = useState(editing?.label ?? "");
  const [color, setColor] = useState<MarkerColor>(editing?.color ?? "purple");
  const [icon, setIcon] = useState<MarkerIcon>(editing?.icon ?? "tag");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The edited marker went away (deleted elsewhere): nothing left to edit.
  useEffect(() => { if (request.kind === "edit" && !editing && definitions.length) onClose(); }, [request.kind, editing, definitions.length, onClose]);

  const trimmed = name.trim();
  const existing = request.kind === "apply" && trimmed ? resolveMarker(definitions, trimmed) : undefined;
  const shown = existing ?? { color, icon };
  const custom = definitions.filter((marker) => !marker.builtIn);
  const query = trimmed.toLocaleLowerCase(host.ui.locale.get());
  const suggestions = request.kind === "apply"
    ? custom.filter((marker) => !query || marker.label.toLocaleLowerCase(host.ui.locale.get()).includes(query)).slice(0, 8)
    : [];

  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (request.kind === "edit") {
        await updateMarker(request.id, { label: trimmed, color, icon });
      } else if (request.kind === "create") {
        await createMarker({ label: trimmed, color, icon });
      } else {
        const marker = existing ?? await createMarker({ label: trimmed, color, icon });
        await changeMarkers({
          sessionIds: request.sessionIds,
          add: [{ marker: marker.id, ...(note.trim() ? { note: note.trim() } : {}) }],
        });
      }
      onClose();
    } catch (cause) {
      setError(host.errors.friendly(tr("sessionmarkers.error.update"), cause));
      setBusy(false);
    }
  };

  const title = request.kind === "edit"
    ? tr("sessionmarkers.dialog.editTitle")
    : request.kind === "create" ? tr("sessionmarkers.dialog.newTitle") : tr("sessionmarkers.dialog.title");
  const action = request.kind === "edit"
    ? tr("sessionmarkers.dialog.save")
    : request.kind === "create" ? tr("sessionmarkers.dialog.create") : tr("sessionmarkers.dialog.add");

  return (
    <Dialog
      title={title}
      onClose={onClose}
      className="session-markers-dialog"
      initialFocus="input.session-markers-dialog__name"
      footer={(
        <>
          <Button variant="quiet" onClick={onClose}>{tr("sessionmarkers.dialog.cancel")}</Button>
          <Button variant="primary" busy={busy} disabled={!trimmed || busy} onClick={() => void submit()}>{action}</Button>
        </>
      )}
    >
      <form
        className="session-markers-dialog__form"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <label className="session-markers-dialog__field">
          <span className="session-markers-dialog__label">{tr("sessionmarkers.dialog.name")}</span>
          <span className="session-markers-dialog__name-row">
            <MarkerGlyph definition={shown} size="md" />
            <TextInput
              className="session-markers-dialog__name"
              value={name}
              maxLength={MARKER_LABEL_MAX}
              placeholder={tr("sessionmarkers.dialog.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </span>
        </label>
        {suggestions.length > 0 && (
          <div className="session-markers-dialog__field">
            <span className="session-markers-dialog__label">{tr("sessionmarkers.dialog.existing")}</span>
            <div className="session-markers-dialog__suggestions">
              {suggestions.map((marker) => (
                <button
                  key={marker.id}
                  type="button"
                  className="session-markers-dialog__suggestion"
                  aria-pressed={existing?.id === marker.id}
                  onClick={() => setName(marker.label)}
                >
                  <MarkerGlyph definition={marker} />
                  <span>{markerLabel(marker)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <fieldset className="session-markers-dialog__field" disabled={!!existing}>
          <legend className="session-markers-dialog__label">{tr("sessionmarkers.dialog.color")}</legend>
          <div className="session-markers-dialog__swatches" role="radiogroup" aria-label={tr("sessionmarkers.dialog.color")}>
            {MARKER_COLORS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={shown.color === value}
                aria-label={colorLabel(value)}
                title={colorLabel(value)}
                className="session-markers-dialog__swatch"
                data-color={value}
                onClick={() => setColor(value)}
              />
            ))}
          </div>
        </fieldset>
        <fieldset className="session-markers-dialog__field" disabled={!!existing}>
          <legend className="session-markers-dialog__label">{tr("sessionmarkers.dialog.icon")}</legend>
          <div className="session-markers-dialog__icons" role="radiogroup" aria-label={tr("sessionmarkers.dialog.icon")}>
            {MARKER_ICONS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={shown.icon === value}
                aria-label={iconLabel(value)}
                title={iconLabel(value)}
                className="session-markers-dialog__icon"
                onClick={() => setIcon(value)}
              >
                <MarkerGlyph definition={{ color: shown.color, icon: value }} size="md" />
              </button>
            ))}
          </div>
        </fieldset>
        {request.kind === "apply" && (
          <label className="session-markers-dialog__field">
            <span className="session-markers-dialog__label">{tr("sessionmarkers.dialog.note")}</span>
            <TextInput
              value={note}
              maxLength={MARKER_NOTE_MAX}
              placeholder={tr("sessionmarkers.dialog.notePlaceholder")}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
        )}
        {error && <p className="session-markers-dialog__error" role="alert">{error}</p>}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
