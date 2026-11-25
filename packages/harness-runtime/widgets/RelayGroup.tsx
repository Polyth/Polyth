// Relay inside Settings → Harnesses → harness → Accounts. The account list is
// one list (HarnessAccounts): each row carries its own Relay switch, order
// handle, now/next badge and limit reading. This file owns the Relay state
// (load, optimistic save), the summary card above the list and those row parts.
import { useCallback, useEffect, useRef, useState, type DragEvent, type HTMLAttributes, type KeyboardEvent, type ReactElement } from "react";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { Badge, Button, ChevronRightIcon, DragHandleIcon, Icon, Notice, Switch, SyncIcon } from "../../../apps/web/src/components/ui/index.ts";
import { Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import { replaceRelayPrefs, useRelayPrefs } from "./relayPrefs.ts";
import {
  includedIds,
  meterText,
  moveIncluded,
  orderedMembers,
  reasonText,
  refillTime,
  relayAvailable,
  relayListed,
  reorderIncluded,
  routeMembers,
  setIncluded,
  type RelayMemberView,
  type RelayTranslate,
  type RelayView,
} from "./relayModel.ts";

const api = createApiTransport();
const HANDOVER_LEVELS = [0.02, 0.05, 0.1] as const;

export interface Relay {
  /** Absent: no Relay for this server or device (older server, 403/404). */
  view?: RelayView;
  rows: RelayMemberView[];
  t: RelayTranslate;
  now: number;
  saving: boolean;
  /** The member whose Relay switch is being saved, if any. */
  pending: string;
  failure: string;
  /** Two or more accounts this person may use: Relay is offered at all. */
  available: boolean;
  /** Two or more members: the Relay harness is in this person's picker. */
  listed: boolean;
  manual: boolean;
  /** `<label> · Relay`, the harness name people pick. */
  name: string;
  member(harnessId: string): RelayMemberView | undefined;
  include(harnessId: string, included: boolean): void;
  /** With My order, whether a member can move one place up (-1) or down (1). */
  canMove(harnessId: string, delta: -1 | 1): boolean;
  /** Moves a member one place; the row menu's way, for touch and keyboards. */
  move(harnessId: string, delta: -1 | 1): void;
  options(patch: Partial<RelayView["settings"]>): void;
  /** Read the Relay again (an account was added, renamed or removed). */
  reload(): Promise<void>;
  /** Leading order cell of a row while the order is manual. */
  lead(harnessId: string, label: string, disabled: boolean): ReactElement;
  /** Drop target props for a member row while the order is manual. */
  dropTarget(harnessId: string): Pick<HTMLAttributes<HTMLElement>, "onDragOver" | "onDrop"> & { "data-dragging"?: "true" };
}

/** Loads the person's Relay for `family` and saves changes optimistically:
 *  a refused save rolls the rows back and says why. */
export function useRelay({ host, family, onChanged }: { host: WebPackageHost; family: string; onChanged?(): void }): Relay {
  const t: RelayTranslate = useCallback((key, values) => host.ui.locale.translate(`harnessruntime.relay.${key}`, values), [host]);
  const [view, setView] = useState<RelayView>();
  const [rows, setRows] = useState<RelayMemberView[]>([]);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState("");
  const [failure, setFailure] = useState("");
  const [dragged, setDragged] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const handles = useRef(new Map<string, HTMLElement>());
  const focusAfter = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const body = await api.get<{ relays?: RelayView[] }>("/api/harnesses/relays");
      const found = body.relays?.find((relay) => relay.family === family);
      setView(found);
      setRows(found ? orderedMembers(found) : []);
      setNow(Date.now());
    } catch {
      // 404/403: no Relay for this server or device.
      setView(undefined);
    }
  }, [family]);
  useEffect(() => {
    void load();
    const focus = () => { void load(); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [load]);
  useEffect(() => {
    if (!focusAfter.current) return;
    handles.current.get(focusAfter.current)?.focus();
    focusAfter.current = undefined;
  });

  const save = async (nextRows: RelayMemberView[], patch: Partial<RelayView["settings"]> = {}) => {
    if (!view) return;
    const before = { view, rows };
    const settings = { ...view.settings, ...patch, members: includedIds(nextRows) };
    setRows(nextRows);
    setView({ ...view, settings });
    setSaving(true);
    setFailure("");
    try {
      const saved = await api.put<RelayView>(`/api/harnesses/relays/${view.id}`, { members: settings.members, order: settings.order, handoverAt: settings.handoverAt });
      setView(saved);
      setRows(orderedMembers(saved));
      setNow(Date.now());
      onChanged?.();
    } catch (cause) {
      setView(before.view);
      setRows(before.rows);
      setFailure(host.errors.friendly(t("action.save"), cause));
    } finally {
      setSaving(false);
    }
  };

  const manual = view?.settings.order === "manual";
  const onKey = (event: KeyboardEvent<HTMLElement>, harnessId: string) => {
    if (!manual || saving || !event.altKey || !event.shiftKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    focusAfter.current = harnessId;
    void save(moveIncluded(rows, harnessId, event.key === "ArrowUp" ? -1 : 1));
  };

  return {
    ...(view ? { view } : {}),
    rows,
    t,
    now,
    saving,
    pending,
    failure,
    available: relayAvailable(view),
    listed: relayListed(rows),
    manual,
    name: view ? `${view.label} · ${t("title")}` : t("title"),
    member: (harnessId) => rows.find((row) => row.harnessId === harnessId),
    include: (harnessId, included) => {
      if (saving) return;
      setPending(harnessId);
      void save(setIncluded(rows, harnessId, included)).finally(() => setPending(""));
    },
    canMove: (harnessId, delta) => {
      const ids = includedIds(rows);
      const at = ids.indexOf(harnessId);
      return manual && at >= 0 && at + delta >= 0 && at + delta < ids.length;
    },
    move: (harnessId, delta) => { if (manual && !saving) void save(moveIncluded(rows, harnessId, delta)); },
    options: (patch) => void save(rows, patch),
    reload: load,
    lead: (harnessId, label, disabled) => {
      const row = rows.find((candidate) => candidate.harnessId === harnessId);
      const draggable = Boolean(row?.included) && !disabled && !saving;
      if (!row?.included) return <span className="pkg-harnesses-relay-lead" aria-hidden="true" />;
      return <span className="pkg-harnesses-relay-lead">
        <span
          ref={(node) => { if (node) handles.current.set(harnessId, node); else handles.current.delete(harnessId); }}
          className="pkg-harnesses-drag pkg-harnesses-relay-handle"
          role={draggable ? "button" : undefined}
          tabIndex={draggable ? 0 : undefined}
          aria-label={draggable ? t("drag", { name: label }) : undefined}
          aria-keyshortcuts={draggable ? "Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined}
          aria-hidden={draggable ? undefined : "true"}
          draggable={draggable}
          onKeyDown={(event) => onKey(event, harnessId)}
          onDragStart={(event: DragEvent<HTMLElement>) => { setDragged(harnessId); event.dataTransfer.setData("text/plain", harnessId); }}
          onDragEnd={() => setDragged(undefined)}
        ><Icon icon={DragHandleIcon} size="sm" /></span>
        <span className="pkg-harnesses-relay-pos" aria-label={t("position", { n: row.position ?? 0 })}>{row.position}</span>
      </span>;
    },
    dropTarget: (harnessId) => {
      const row = rows.find((candidate) => candidate.harnessId === harnessId);
      if (!manual || !row?.included) return {};
      return {
        ...(dragged === harnessId ? { "data-dragging": "true" as const } : {}),
        onDragOver: (event) => event.preventDefault(),
        onDrop: (event) => {
          event.preventDefault();
          const id = event.dataTransfer.getData("text/plain") || dragged;
          setDragged(undefined);
          if (id) void save(reorderIncluded(rows, id, includedIds(rows).indexOf(harnessId)));
        },
      };
    },
  };
}

/** A member's place in the queue, beside its name. */
export function RelayBadge({ relay, harnessId }: { relay: Relay; harnessId: string }) {
  const row = relay.member(harnessId);
  if (!row?.included) return null;
  if (row.state === "now") return <Badge tone="accent" className="pkg-harnesses-relay-badge">{relay.t("state.now")}</Badge>;
  if (row.state === "next") return <Badge className="pkg-harnesses-relay-badge">{relay.t("state.next")}</Badge>;
  if (row.state === "exhausted") return <Badge tone="warning" className="pkg-harnesses-relay-badge">{relay.t("state.exhausted")}</Badge>;
  if (row.state === "skipped") return <Badge className="pkg-harnesses-relay-badge">{relay.t("state.skipped")}</Badge>;
  return null;
}

/** A member's tightest limit window and, when Relay passes it over, why. A
 *  signed-out member says so in the account status already. */
export function RelayReading({ relay, harnessId, locale }: { relay: Relay; harnessId: string; locale: string }) {
  const row = relay.member(harnessId);
  if (!row?.included) return null;
  const reason = row.reason && row.reason !== "signed-out" ? reasonText(row, relay.t, relay.now, locale) : undefined;
  const percent = row.tightest ? Math.round(row.tightest.remaining * 100) : undefined;
  return <span className="pkg-harnesses-relay-reading" data-testid="relay-reading">
    {percent !== undefined
      ? <span className="pkg-harnesses-relay-meter" role="img" aria-label={relay.t("meterAria", { percent })} data-low={percent < 20 ? "true" : undefined}><i style={{ inlineSize: `${percent}%` }} /></span>
      : <span className="pkg-harnesses-relay-meter" data-empty="true" aria-hidden="true" />}
    <small>
      {reason && <span className="pkg-harnesses-relay-note" data-tone="warn">{reason}</span>}
      <span>{meterText(row, relay.t, relay.now, locale)}</span>
    </small>
  </span>;
}

/** The summary above the account list: on or off, the route a Relay chat
 *  takes now, and the less frequent options folded away. */
export function RelayCard({ host, relay, accountName }: { host: WebPackageHost; relay: Relay; accountName(harnessId: string): string }) {
  const prefs = useRelayPrefs();
  const view = relay.view;
  if (!view || !relay.available) return null;
  const t = relay.t;
  const locale = host.ui.locale.get();
  const members = relay.rows.filter((row) => row.included).length;
  const route = routeMembers(relay.rows);
  const exhausted = relay.listed && view.exhaustedUntil !== undefined;
  const optionsSummary = `${view.settings.order === "manual" ? t("order.manual") : t("order.expire")} · ${t("handover.summary", { percent: Math.round(view.settings.handoverAt * 100) })}`;
  return <section className="pkg-harnesses-relay" aria-labelledby="pkg-harnesses-accounts-relay" data-listed={relay.listed ? "true" : "false"}>
    <header className="pkg-harnesses-relay-head">
      <span className="pkg-harnesses-relay-mark" aria-hidden="true"><Icon icon={SyncIcon} size="sm" /></span>
      <h4 id="pkg-harnesses-accounts-relay">{t("title")} <span className="pkg-harnesses-relay-sub">{t("sub")}</span></h4>
      {exhausted
        ? <Badge tone="warning" dot>{t("status.outUntil", { time: refillTime(view.exhaustedUntil!, relay.now, locale) })}</Badge>
        : relay.listed
          ? <Badge tone="success" dot>{t("status.on", { count: members })}</Badge>
          : <Badge>{t("status.off")}</Badge>}
    </header>
    {relay.listed
      ? <>
          <p className="pkg-harnesses-accounts-help">{t("hint", { name: relay.name })}</p>
          <ol className="pkg-harnesses-relay-route" aria-label={t("route")}>
            {route.map((row) => <li key={row.harnessId} data-state={row.state}>
              <span className="pkg-harnesses-relay-stop">
                <span className="pkg-harnesses-relay-stop-name">{accountName(row.harnessId)}</span>
                {(row.state === "now" || row.state === "exhausted" || row.state === "skipped") && <small><span className="sr-only"> · </span>{t(`state.${row.state}`)}</small>}
              </span>
            </li>)}
          </ol>
        </>
      : <p className="pkg-harnesses-accounts-help" data-testid="relay-needs-two">{members === 0 ? t("pickTwo", { name: relay.name }) : t("pickOneMore", { name: relay.name })}</p>}
    {relay.failure && <Notice tone="error" role="alert">{relay.failure}</Notice>}
    <details className="pkg-harnesses-relay-options">
      <summary><span>{t("options")}</span><small>{optionsSummary}</small></summary>
      <div className="pkg-harnesses-relay-options-body">
        <div className="pkg-harnesses-relay-control">
          <span className="pkg-harnesses-relay-label">{t("order")}</span>
          <Seg label={t("order")} value={view.settings.order} disabled={relay.saving} options={[["expire-first", t("order.expire")], ["manual", t("order.manual")]]} onChange={(order) => relay.options({ order })} />
          <span className="pkg-harnesses-accounts-help">{relay.manual ? t("order.manualHint") : t("order.expireHint")}</span>
        </div>
        <div className="pkg-harnesses-relay-control">
          <span className="pkg-harnesses-relay-label">{t("handover")}</span>
          <Seg label={t("handover.aria")} value={view.settings.handoverAt} disabled={relay.saving} options={HANDOVER_LEVELS.map((level): [number, string] => [level, `${Math.round(level * 100)}%`])} onChange={(handoverAt) => relay.options({ handoverAt })} />
          <span className="pkg-harnesses-accounts-help">{t("cacheNote")}</span>
        </div>
        <div className="pkg-harnesses-relay-control">
          <span className="pkg-harnesses-relay-label" id="pkg-harnesses-relay-show">{t("showHandovers")}</span>
          <Switch checked={prefs.showHandovers} labelledBy="pkg-harnesses-relay-show" onChange={(showHandovers) => replaceRelayPrefs({ showHandovers })} />
          <span className="pkg-harnesses-accounts-help">{t("showHandoversHint")}</span>
        </div>
        {relay.listed && <div className="pkg-harnesses-relay-link">
          <span className="pkg-harnesses-accounts-help">{t("settingsLink", { name: relay.name })}</span>
          <Button size="sm" variant="ghost" iconEnd={ChevronRightIcon} onClick={() => host.navigation.openSettingsPage("harnesses", { itemId: view.id })}>{t("openSettings", { name: relay.name })}</Button>
        </div>}
      </div>
    </details>
  </section>;
}
