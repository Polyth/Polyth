import { useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { Button, DragHandleIcon, Icon, KeyIcon, Notice, Switch } from "../../../apps/web/src/components/ui/index.ts";
import { Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import type { AccountRow } from "./accountsModel.ts";
import { replaceRelayPrefs, useRelayPrefs } from "./relayPrefs.ts";
import {
  includedIds,
  meterText,
  moveIncluded,
  orderedMembers,
  reasonText,
  reorderIncluded,
  setIncluded,
  type RelayMemberView,
  type RelayTranslate,
  type RelayView,
} from "./relayModel.ts";

const api = createApiTransport();
const HANDOVER_LEVELS = [0.02, 0.05, 0.1] as const;

/** The per-family Relay: which accounts a Relay chat spends, in what order and
 *  when it moves on. Renders nothing when the server has no Relay for the
 *  family (older server, paired device without access). */
export default function RelayGroup({ host, family, accounts, manageable, busy, onSignIn, onChanged }: {
  host: WebPackageHost;
  family: string;
  accounts: readonly AccountRow[];
  manageable: boolean;
  busy: boolean;
  onSignIn(row: AccountRow): void;
  /** The Relay is a harness of its own: refresh catalogs after a save. */
  onChanged?(): void;
}) {
  const t: RelayTranslate = useCallback((key, values) => host.ui.locale.translate(`harnessruntime.relay.${key}`, values), [host]);
  const [view, setView] = useState<RelayView>();
  const [rows, setRows] = useState<RelayMemberView[]>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  const [dragged, setDragged] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const prefs = useRelayPrefs();
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

  if (!view) return null;
  const locale = host.ui.locale.get();
  const manual = view.settings.order === "manual";
  const disabled = saving || busy;

  /** Optimistic: show the change now, roll it back if the server refuses. */
  const save = async (nextRows: RelayMemberView[], patch: Partial<RelayView["settings"]> = {}) => {
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

  const includedCount = rows.filter((row) => row.included).length;
  const relayName = `${view.label} · ${t("title")}`;
  const onKey = (event: KeyboardEvent<HTMLElement>, row: RelayMemberView) => {
    if (!manual || !row.included || disabled || !event.altKey || !event.shiftKey) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    focusAfter.current = row.harnessId;
    void save(moveIncluded(rows, row.harnessId, event.key === "ArrowUp" ? -1 : 1));
  };

  const renderRow = (row: RelayMemberView) => {
    const account = accounts.find((candidate) => candidate.harnessId === row.harnessId);
    const reason = reasonText(row, t, now, locale);
    const canSignIn = row.reason === "signed-out" && Boolean(account?.signInCommand) && manageable;
    const draggable = manual && row.included && !disabled;
    return <li
      key={row.harnessId}
      className={`pkg-harnesses-accounts-row pkg-harnesses-relay-row${dragged === row.harnessId ? " dragging" : ""}`}
      data-state={row.state}
      data-included={row.included ? "true" : "false"}
      data-testid="relay-row"
      onDragOver={(event) => { if (manual && row.included) event.preventDefault(); }}
      onDrop={(event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        const id = event.dataTransfer.getData("text/plain") || dragged;
        setDragged(undefined);
        if (id && row.included) void save(reorderIncluded(rows, id, includedIds(rows).indexOf(row.harnessId)));
      }}
    >
      <span
        ref={(node) => { if (node) handles.current.set(row.harnessId, node); else handles.current.delete(row.harnessId); }}
        className="pkg-harnesses-drag pkg-harnesses-relay-handle"
        role={draggable ? "button" : undefined}
        tabIndex={draggable ? 0 : undefined}
        aria-label={draggable ? t("drag", { name: row.name }) : undefined}
        aria-keyshortcuts={draggable ? "Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined}
        aria-hidden={draggable ? undefined : "true"}
        data-locked={manual && row.included ? undefined : "true"}
        draggable={draggable}
        onKeyDown={(event) => onKey(event, row)}
        onDragStart={(event: DragEvent<HTMLElement>) => { setDragged(row.harnessId); event.dataTransfer.setData("text/plain", row.harnessId); }}
        onDragEnd={() => setDragged(undefined)}
      ><Icon icon={DragHandleIcon} size="sm" /></span>
      <span className="pkg-harnesses-relay-pos" aria-label={row.position ? t("position", { n: row.position }) : undefined}>{row.position ?? ""}</span>
      <label className="pkg-harnesses-relay-include">
        <input type="checkbox" checked={row.included} disabled={disabled} aria-label={t("include", { name: row.name })} onChange={(event) => void save(setIncluded(rows, row.harnessId, event.target.checked))} />
      </label>
      <span className="pkg-harnesses-accounts-name">
        <span className="pkg-harnesses-accounts-title">
          <strong>{account ? (account.name || host.ui.locale.translate("harnessruntime.accounts.defaultName")) : row.name}</strong>
          {row.included && (row.state === "now" || row.state === "next") && <span className="pkg-harnesses-relay-badge" data-kind={row.state}>{t(`state.${row.state}`)}</span>}
        </span>
        <small>
          {row.included && row.state === "exhausted" && <span className="pkg-harnesses-relay-note" data-tone="warn">{reason ?? t("state.exhausted")}</span>}
          {row.included && row.state === "skipped" && <span className="pkg-harnesses-relay-note" data-tone="warn">{reason ?? t("state.skipped")}</span>}
          {row.included && row.state !== "skipped" && row.state !== "exhausted" && row.reason && <span className="pkg-harnesses-relay-note" data-tone="warn">{reason}</span>}
          {row.ownerName && row.owner === "shared-by-other" && <span>{row.ownerName}</span>}
          {row.tightest || row.included ? <span className="pkg-harnesses-relay-reading">{meterText(row, t, now, locale)}</span> : null}
        </small>
        {row.tightest && <span className="pkg-harnesses-relay-meter" role="img" aria-label={t("meterAria", { percent: Math.round(row.tightest.remaining * 100) })} data-low={row.tightest.remaining < 0.2 ? "true" : undefined}><i style={{ inlineSize: `${Math.round(row.tightest.remaining * 100)}%` }} /></span>}
        {!row.tightest && row.included && <span className="pkg-harnesses-relay-meter" data-empty="true" aria-hidden="true" />}
      </span>
      {canSignIn && account && <span className="pkg-harnesses-accounts-actions"><Button size="sm" variant="primary" iconStart={KeyIcon} disabled={busy} onClick={() => onSignIn(account)}>{t("signIn")}</Button></span>}
    </li>;
  };

  return <section className="pkg-harnesses-accounts-group pkg-harnesses-relay" aria-labelledby="pkg-harnesses-accounts-relay">
    <header className="pkg-harnesses-accounts-group-head">
      <h4 id="pkg-harnesses-accounts-relay">{t("title")} <span className="pkg-harnesses-relay-sub">{t("sub")}</span></h4>
      <p className="pkg-harnesses-accounts-help">{t("hint", { name: relayName })}</p>
    </header>
    {failure && <Notice tone="error" role="alert">{failure}</Notice>}
    {includedCount === 0 && <p className="pkg-harnesses-accounts-empty">{t("empty")}</p>}
    {includedCount === 1 && <p className="pkg-harnesses-accounts-help" data-testid="relay-needs-two">{t("needsTwo")}</p>}
    {rows.length > 0 && <ul className="pkg-harnesses-accounts-list" aria-label={t("list")}>{rows.map(renderRow)}</ul>}
    <div className="pkg-harnesses-relay-foot">
      <div className="pkg-harnesses-relay-control">
        <span className="pkg-harnesses-relay-label">{t("order")}</span>
        <Seg label={t("order")} value={view.settings.order} disabled={disabled} options={[["expire-first", t("order.expire")], ["manual", t("order.manual")]]} onChange={(order) => void save(rows, { order })} />
        <span className="pkg-harnesses-accounts-help">{manual ? t("order.manualHint") : t("order.expireHint")}</span>
      </div>
      <div className="pkg-harnesses-relay-control">
        <span className="pkg-harnesses-relay-label">{t("handover")}</span>
        <Seg label={t("handover.aria")} value={view.settings.handoverAt} disabled={disabled} options={HANDOVER_LEVELS.map((level): [number, string] => [level, `${Math.round(level * 100)}%`])} onChange={(handoverAt) => void save(rows, { handoverAt })} />
      </div>
      <div className="pkg-harnesses-relay-control">
        <span className="pkg-harnesses-relay-label" id="pkg-harnesses-relay-show">{t("showHandovers")}</span>
        <Switch checked={prefs.showHandovers} labelledBy="pkg-harnesses-relay-show" onChange={(showHandovers) => replaceRelayPrefs({ showHandovers })} />
        <span className="pkg-harnesses-accounts-help">{t("showHandoversHint")}</span>
      </div>
      <p className="pkg-harnesses-accounts-help">{t("cacheNote")}</p>
      <p className="pkg-harnesses-accounts-help">{t("settingsLink", { name: relayName })}</p>
      <div><Button size="sm" variant="ghost" onClick={() => host.navigation.openSettingsPage("harnesses", { itemId: view.id })}>{t("openSettings", { name: relayName })}</Button></div>
    </div>
  </section>;
}
