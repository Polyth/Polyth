// Relay inside Settings → Harnesses → harness → Accounts. The account list is
// harness-runtime's one list (HarnessAccounts), which this package joins
// through its Relay seam: each row carries its own Relay switch, order
// handle, now/next badge and limit reading. This file owns the Relay state
// (load, optimistic save), the summary card above the list and those row parts.
import { useCallback, useEffect, useRef, useState, type DragEvent, type HTMLAttributes, type KeyboardEvent, type ReactElement } from "react";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { Badge, Button, ChevronRightIcon, DragHandleIcon, Icon, Notice, Switch, SyncIcon } from "../../../apps/web/src/components/ui/index.ts";
import { Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import {
  refillTime,
  RelayPolicyNotice,
  replaceRelayPrefs,
  useRelayPrefs,
  type Relay,
  type RelayMemberView,
  type RelayTranslate,
  type RelayView,
} from "@polyth/harness-runtime/relay-ui";
import { RELAY_FAMILIES_PATH, RELAYS_PATH, type RelayFamilyView, type RelaysResponse } from "../src/views.ts";
import {
  includedIds,
  meterText,
  moveIncluded,
  orderedMembers,
  reasonText,
  relayAvailable,
  relayListed,
  reorderIncluded,
  routeMembers,
  setIncluded,
} from "./relayModel.ts";

const api = createApiTransport();
const HANDOVER_LEVELS = [0.02, 0.05, 0.1] as const;

/** What this package's own parts read beyond the seam's `Relay`. */
interface FamilyRelay extends Relay {
  /** The family's switch and vendor policy; absent on an older server. */
  family?: RelayFamilyView;
  /** Turn the family's Relay on or off (server admins). */
  enable(enabled: boolean): void;
}

/** Loads the person's Relay for `family` and saves changes optimistically:
 *  a refused save rolls the rows back and says why. */
export function useRelay({ host, family, onChanged }: { host: WebPackageHost; family: string; onChanged?(): void }): Relay {
  const t: RelayTranslate = useCallback((key, values) => host.ui.locale.translate(`harnessrelay.${key}`, values), [host]);
  const [view, setView] = useState<RelayView>();
  const [familyView, setFamilyView] = useState<RelayFamilyView>();
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
      const body = await api.get<Partial<RelaysResponse>>(RELAYS_PATH);
      const found = body.relays?.find((relay) => relay.family === family);
      setFamilyView(body.families?.find((candidate) => candidate.family === family));
      setView(found);
      setRows(found ? orderedMembers(found) : []);
      setNow(Date.now());
    } catch {
      // 404/403: no Relay for this server or device.
      setView(undefined);
      setFamilyView(undefined);
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
      const saved = await api.put<RelayView>(`${RELAYS_PATH}/${view.id}`, { members: settings.members, order: settings.order, handoverAt: settings.handoverAt });
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

  const enable = async (enabled: boolean) => {
    setSaving(true);
    setFailure("");
    try {
      await api.put<RelayFamilyView>(`${RELAY_FAMILIES_PATH}/${family}`, { enabled });
      await load();
      // The Relay harness appeared or left: lists and pickers must follow.
      onChanged?.();
    } catch (cause) {
      setFailure(host.errors.friendly(t("action.switch"), cause));
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

  const relay: FamilyRelay = {
    ...(view ? { view } : {}),
    ...(familyView ? { family: familyView } : {}),
    enable: (enabled) => { if (!saving) void enable(enabled); },
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
  return relay;
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
  const { family, enable } = relay as FamilyRelay;
  const view = relay.view;
  const t = relay.t;
  const policy = family && <RelayPolicyNotice host={host} policy={family.policy} name={family.label} />;
  if (!view || !relay.available) {
    // Off for this harness: say why, and offer the switch to whoever may flip it.
    if (!family || family.enabled || !family.offered) return null;
    return <section className="pkg-harnesses-relay" aria-labelledby="pkg-harnesses-accounts-relay" data-listed="false" data-testid="relay-off">
      <header className="pkg-harnesses-relay-head">
        <span className="pkg-harnesses-relay-mark" aria-hidden="true"><Icon icon={SyncIcon} size="sm" /></span>
        <h4 id="pkg-harnesses-accounts-relay">{t("title")} <span className="pkg-harnesses-relay-sub">{t("sub")}</span></h4>
        <Badge>{t("status.off")}</Badge>
      </header>
      {policy}
      {relay.failure && <Notice tone="error" role="alert">{relay.failure}</Notice>}
      {family.editable
        ? <div><Button size="sm" busy={relay.saving} data-testid="relay-enable" onClick={() => enable(true)}>{t(family.policy === "unsupported" ? "family.enableAck" : "family.enable")}</Button></div>
        : family.policy !== "prohibited" && <p className="pkg-harnesses-accounts-help">{t("family.adminOnly", { name: family.label })}</p>}
    </section>;
  }
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
    {policy}
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
        {family?.editable && <div className="pkg-harnesses-relay-link">
          <span className="pkg-harnesses-accounts-help">{t("family.disableHint", { name: relay.name })}</span>
          <Button size="sm" variant="ghost" disabled={relay.saving} data-testid="relay-disable" onClick={() => enable(false)}>{t("family.disable")}</Button>
        </div>}
        {relay.listed && <div className="pkg-harnesses-relay-link">
          <span className="pkg-harnesses-accounts-help">{t("settingsLink", { name: relay.name })}</span>
          <Button size="sm" variant="ghost" iconEnd={ChevronRightIcon} onClick={() => host.navigation.openSettingsPage("harnesses", { itemId: view.id })}>{t("openSettings", { name: relay.name })}</Button>
        </div>}
      </div>
    </details>
  </section>;
}
