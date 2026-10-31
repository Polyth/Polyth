// Share a chat (Spaces §14.3): who besides its owner can open it and what each
// person may do. The server owns the rules — `allowedVisibilities`, `maxGrant`
// and `canShare` come from it — and the people list is sent as one full
// replacement guarded by `expectedRevision`. A delegated subagent follows its
// parent chat, so it only explains that and links to the parent's sharing.
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  SESSION_ACCESS_LEVELS,
  SESSION_VISIBILITIES,
  sessionAccessAtLeast,
  type SessionAccessLevel,
  type SessionProjection,
  type SessionShareGrantDto,
  type SessionSharingDto,
  type SessionVisibility,
} from "@polyth/contracts";
import { httpStatusOf } from "@polyth/session/web-api";
import { openSessionSharing, setOverlay, useStore } from "../store.ts";
import { tr } from "../i18n/index.ts";
import { friendlyError } from "../settings.ts";
import { announce } from "./a11y/live.tsx";
import {
  accessLabel, canManageSession, loadSessionSharing, ownerName, saveSessionSharing, sharingMarkerLabel,
} from "../sessionSharing.ts";
import {
  Button, CheckIcon, CloseIcon, Icon, IconButton, LockIcon, ResponsiveOverlay, Select, SharedIcon, Skeleton,
} from "./ui/index.ts";
import "./ShareSessionDialog.css";

const AUDIENCE: Record<SessionVisibility, { label: () => string; hint: () => string }> = {
  private: { label: () => tr("sharing.private"), hint: () => tr("sharing.privateHint") },
  restricted: { label: () => tr("sharing.restricted"), hint: () => tr("sharing.restrictedHint") },
  space: { label: () => tr("sharing.space"), hint: () => tr("sharing.spaceHint") },
};

const initials = (name: string): string =>
  name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";

const sameGrants = (a: readonly SessionShareGrantDto[], b: readonly SessionShareGrantDto[]): boolean =>
  a.length === b.length && a.every((grant, index) => grant.userId === b[index]?.userId && grant.access === b[index]?.access);

function Person({ name, detail, children }: { name: string; detail?: string; children?: ReactNode }) {
  return (
    <li className="session-sharing-person">
      <span className="user-avatar" aria-hidden="true">{initials(name)}</span>
      <span className="session-sharing-person-copy">
        <span className="session-sharing-person-name">{name}</span>
        {detail && <span className="session-sharing-person-detail">{detail}</span>}
      </span>
      {children}
    </li>
  );
}

/** One quiet line for a session overview: who can open the chat, and the
 *  door to its sharing. Nothing without canonical identity. */
export function SessionSharingLine({ session, onOpen }: {
  session: Pick<SessionProjection, "id" | "sharing">;
  onOpen?: () => void;
}) {
  if (!session.sharing) return null;
  const shared = sharingMarkerLabel(session.sharing);
  return (
    <div className="session-sharing-line">
      <Icon icon={shared ? SharedIcon : LockIcon} size="sm" />
      <span className="session-sharing-line-text">{shared ?? tr("sharing.private")}</span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          onOpen?.();
          openSessionSharing(session.id);
        }}
      >
        {canManageSession(session) ? tr("sharing.share") : tr("sharing.whoHasAccess")}
      </Button>
    </div>
  );
}

export default function ShareSessionDialog() {
  const sessionId = useStore((state) => state.sharingSessionId);
  // The projection omits `owner` exactly when the reader owns the chat; a chat
  // not in the navigator (a parent opened from a subagent) shows the name.
  const readerIsOwner = useStore((state) => {
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    return !!session?.sharing && !session.sharing.owner;
  });
  const [dto, setDto] = useState<SessionSharingDto | null>(null);
  const [visibility, setVisibility] = useState<SessionVisibility>("private");
  const [grants, setGrants] = useState<SessionShareGrantDto[]>([]);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const audienceId = useId();

  // Another chat (the parent's sharing) starts clean; a reload keeps showing
  // the current state under its notice.
  useEffect(() => {
    setDto(null);
    setNotice(null);
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    setFailed(false);
    void loadSessionSharing(sessionId).then((next) => {
      if (!live) return;
      setDto(next);
      setVisibility(next.visibility);
      setGrants(next.grants);
    }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [sessionId, reload]);

  const names = useMemo(() => new Map([
    ...(dto?.people ?? []).map((person) => [person.userId, person.name] as const),
    ...(dto?.grants ?? []).map((grant) => [grant.userId, grant.name] as const),
  ]), [dto]);

  if (!sessionId) return null;
  const close = () => setOverlay(null);
  const editable = !!dto && dto.canShare && !dto.inherited;
  const dirty = !!dto && (visibility !== dto.visibility || (visibility !== "private" && !sameGrants(grants, dto.grants)));
  const levels = SESSION_ACCESS_LEVELS.filter((level) => dto?.maxGrant && sessionAccessAtLeast(dto.maxGrant, level));
  const granted = new Set(grants.map((grant) => grant.userId));
  const addable = (dto?.people ?? []).filter((person) => !granted.has(person.userId));
  const nameOf = (userId: string) => ownerName({ name: names.get(userId) ?? "" });

  const save = async () => {
    if (!dto || !dirty || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      await saveSessionSharing(sessionId, {
        visibility,
        grants: visibility === "private" ? [] : grants.map(({ userId, access }) => ({ userId, access })),
        expectedRevision: dto.revision,
      });
      announce(tr("sharing.saved"));
      close();
    } catch (error) {
      const status = httpStatusOf(error);
      if (status === 409 || status === 403) {
        // Someone else moved first (or our rights changed): show the current
        // state and let the person decide again rather than overwrite it.
        setNotice(status === 409 ? tr("sharing.changed") : tr("sharing.forbidden"));
        setReload((value) => value + 1);
      } else {
        setNotice(friendlyError(tr("sharing.saveFailed"), error));
      }
    } finally {
      setSaving(false);
    }
  };

  const setAccess = (userId: string, access: SessionAccessLevel) =>
    setGrants((current) => current.map((grant) => grant.userId === userId ? { ...grant, access } : grant));
  const addPerson = (userId: string) =>
    setGrants((current) => [...current, { userId, ...(names.get(userId) ? { name: names.get(userId)! } : {}), access: "view" }]);
  const removePerson = (userId: string) => setGrants((current) => current.filter((grant) => grant.userId !== userId));

  const footer = editable ? (
    <>
      <Button size="sm" onClick={close}>{tr("common.cancel")}</Button>
      <Button size="sm" variant="primary" disabled={!dirty} busy={saving} onClick={() => void save()}>{tr("common.save")}</Button>
    </>
  ) : <Button size="sm" onClick={close}>{tr("common.close")}</Button>;

  const audience = () => {
    if (!editable) {
      return (
        <div className="session-sharing-audience is-static">
          <span className="session-sharing-choice-label">{AUDIENCE[dto!.visibility].label()}</span>
          <span className="session-sharing-choice-hint">{AUDIENCE[dto!.visibility].hint()}</span>
        </div>
      );
    }
    const allowed = new Set(dto!.allowedVisibilities);
    return (
      <div className="session-sharing-audience" role="radiogroup" aria-labelledby={audienceId}>
        {SESSION_VISIBILITIES.filter((value) => allowed.has(value) || value === dto!.visibility).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={visibility === value}
            disabled={!allowed.has(value)}
            className="session-sharing-choice"
            onClick={() => setVisibility(value)}
          >
            <span className="session-sharing-choice-copy">
              <span className="session-sharing-choice-label">{AUDIENCE[value].label()}</span>
              <span className="session-sharing-choice-hint">{AUDIENCE[value].hint()}</span>
            </span>
            {visibility === value && <Icon icon={CheckIcon} size="sm" className="session-sharing-check" />}
          </button>
        ))}
      </div>
    );
  };

  const people = () => {
    const shown = editable ? grants : dto!.grants;
    if (!editable && (dto!.visibility === "private" || shown.length === 0) && !dto!.owner) return null;
    if (editable && visibility === "private") return null;
    return (
      <section className="session-sharing-section" aria-label={tr("sharing.people")}>
        <h3 className="session-sharing-heading">{tr("sharing.people")}</h3>
        <ul className="session-sharing-people">
          {dto!.owner && (
            <Person name={readerIsOwner ? tr("sharing.you") : ownerName(dto!.owner)} detail={tr("sharing.owner")} />
          )}
          {shown.map((grant) => {
            const name = nameOf(grant.userId);
            const changeable = editable && levels.includes(grant.access);
            return (
              <Person key={grant.userId} name={name} {...(changeable ? {} : { detail: accessLabel(grant.access) })}>
                {changeable && (
                  <Select
                    className="session-sharing-access"
                    label={tr("sharing.accessFor", { name })}
                    ariaLabel={tr("sharing.accessFor", { name })}
                    value={grant.access}
                    options={levels.map((level) => ({ value: level, label: accessLabel(level) }))}
                    onChange={(value) => setAccess(grant.userId, value as SessionAccessLevel)}
                  />
                )}
                {editable && (
                  <IconButton
                    icon={CloseIcon}
                    size="sm"
                    label={tr("sharing.remove", { name })}
                    onClick={() => removePerson(grant.userId)}
                  />
                )}
              </Person>
            );
          })}
        </ul>
        {editable && shown.length === 0 && <p className="session-sharing-empty">{tr("sharing.noPeople")}</p>}
        {editable && addable.length > 0 && levels.length > 0 && (
          <Select
            className="session-sharing-add"
            label={tr("sharing.addPerson")}
            placeholder={tr("sharing.addPersonPlaceholder")}
            options={addable.map((person) => ({ value: person.userId, label: ownerName(person) }))}
            onChange={addPerson}
          />
        )}
      </section>
    );
  };

  const body = () => {
    if (failed && !dto) {
      return (
        <div className="session-sharing-state" role="alert">
          <p>{tr("sharing.loadFailed")}</p>
          <Button size="sm" onClick={() => setReload((value) => value + 1)}>{tr("common.retry")}</Button>
        </div>
      );
    }
    if (!dto) {
      return (
        <div className="session-sharing-state" aria-busy="true" role="status" aria-label={tr("common.loading")}>
          <Skeleton width="62%" />
          <Skeleton width="40%" />
        </div>
      );
    }
    if (dto.inherited) {
      return (
        <div className="session-sharing-state">
          <p>{tr("sharing.inherited")}</p>
          {dto.parentSessionId && (
            <Button size="sm" onClick={() => openSessionSharing(dto.parentSessionId!)}>{tr("sharing.openParent")}</Button>
          )}
        </div>
      );
    }
    return (
      <>
        <section className="session-sharing-section">
          <h3 className="session-sharing-heading" id={audienceId}>{tr("sharing.audience")}</h3>
          {audience()}
        </section>
        {people()}
        {/* Personal MCP servers attach only to the owner's private chats (§14.6). */}
        {dto.personalMcpDetachedOnShare && (editable ? visibility : dto.visibility) !== "private" && (
          <p className="session-sharing-note" data-sharing-mcp-detached="true">{tr("sharing.personalMcpDetached")}</p>
        )}
        {!editable && <p className="session-sharing-note">{tr("sharing.readOnly")}</p>}
      </>
    );
  };

  return (
    <ResponsiveOverlay
      open
      title={editable || !dto ? tr("sharing.title") : tr("sharing.accessTitle")}
      onClose={close}
      desktop="dialog"
      phone="sheet"
      dialogSize="sm"
      className="session-sharing"
      dialogFooter={footer}
      sheetFooter={<div className="session-sharing-sheet-foot">{footer}</div>}
    >
      <div className="session-sharing-body">
        {notice && <p className="session-sharing-notice" role="alert">{notice}</p>}
        {body()}
      </div>
    </ResponsiveOverlay>
  );
}
