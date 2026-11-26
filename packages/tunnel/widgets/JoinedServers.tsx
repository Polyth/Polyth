import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JoinedSpaceDto } from "@polyth/contracts";
import { ApiError, type ApiTransport, type SettingsNavigationTarget } from "@polyth/web-sdk";
import { ErrorState, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { Badge, Button, Dialog, Spinner, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { pairingLinkFromText } from "@polyth/pairing-qr";
import type { Translate } from "./i18n.ts";

// The wire shapes of `/api/tunnel/joined` (src/joinedRoutes.ts).
interface JoinedServer {
  connectionId: string;
  label: string;
  fingerprint: string;
  online: boolean;
}
interface Overview {
  servers: JoinedServer[];
  spaces: JoinedSpaceDto[];
}
interface Preview {
  hostLabel: string;
  fingerprint: string;
  /** A one-time invitation: nobody is at the other end to compare words. */
  invitation?: boolean;
}

/** The pairing in progress: reading the link, comparing words, awaiting approval. */
interface Flow {
  stage: "reading" | "words" | "waiting";
  preview?: Preview;
  attemptId?: string;
  words?: string[];
  invitation?: boolean;
}

const BASE = "/api/tunnel/joined";
/** Refusals that mean this visitor has no joined servers to manage here. */
const UNAVAILABLE = new Set([401, 403, 404]);

/** `join` deep links already acted on, so a remount does not steal focus again. */
const handledTargets = new WeakSet<SettingsNavigationTarget>();

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function ServerRow({ server, spaces, leaving, onRename, onLeave, t }: {
  server: JoinedServer;
  spaces: JoinedSpaceDto[];
  leaving: boolean;
  onRename: (label: string) => Promise<void>;
  onLeave: () => void;
  t: Translate;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const close = () => {
    setDraft(null);
    setError("");
  };
  const save = async (label: string) => {
    setSaving(true);
    setError("");
    try {
      await onRename(label.trim());
      setDraft(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <li className="pkg-tunnel-device pkg-tunnel-server">
      <div className="pkg-tunnel-device-head">
        <span className={`pkg-tunnel-dot${server.online ? " is-online" : ""}`} aria-hidden="true" />
        <div className="pkg-tunnel-device-copy">
          <strong title={server.fingerprint}>{server.label}</strong>
          <span className="pkg-tunnel-server-spaces">
            {spaces.length > 0 ? spaces.map((space) => space.name).join(", ") : t("tunnel.joined.noSpaces")}
          </span>
        </div>
        <Badge tone={server.online ? "success" : "neutral"}>
          {t(server.online ? "tunnel.device.online" : "tunnel.device.offline")}
        </Badge>
        {draft === null && (
          <>
            <Button size="sm" variant="ghost" disabled={leaving} onClick={() => setDraft(server.label)}>
              {t("tunnel.joined.rename")}
            </Button>
            <Button size="sm" variant="ghost" busy={leaving} onClick={onLeave}>{t("tunnel.joined.leave")}</Button>
          </>
        )}
      </div>
      {draft !== null && (
        <div className="pkg-tunnel-device-body">
          <form
            className="pkg-tunnel-join-row pkg-tunnel-rename"
            onSubmit={(event) => {
              event.preventDefault();
              void save(draft);
            }}
          >
            <label htmlFor={id}>{t("tunnel.joined.renameLabel")}</label>
            <TextInput
              id={id}
              name="server-label"
              uiSize="sm"
              value={draft}
              maxLength={80}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                // Escape ends the edit, not the settings window.
                event.preventDefault();
                event.stopPropagation();
                close();
              }}
            />
            <Button size="sm" variant="primary" type="submit" busy={saving}>{t("tunnel.joined.save")}</Button>
            <Button size="sm" variant="ghost" onClick={close}>{t("tunnel.dialog.cancel")}</Button>
          </form>
          {error && <ErrorState compact error={error} />}
        </div>
      )}
    </li>
  );
}

/** The other Polyth servers this signed-in person joined, and joining one. */
export default function JoinedServers({ api, settingsTarget, t }: {
  api: ApiTransport;
  settingsTarget?: SettingsNavigationTarget;
  t: Translate;
}) {
  const inputId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  // Null while loading; "unavailable" hides the section.
  const [overview, setOverview] = useState<Overview | "unavailable" | null>(null);
  const [link, setLink] = useState("");
  const [flow, setFlow] = useState<Flow | null>(null);
  // A title says which action failed; none means the list did not load.
  const [error, setError] = useState<{ text: string; title?: string } | null>(null);
  const [joined, setJoined] = useState("");
  const [leaving, setLeaving] = useState("");
  // Bumped whenever the pairing on screen is abandoned: late answers are stale.
  const runRef = useRef(0);
  /** An attempt the person has not confirmed yet; leaving the page drops it. */
  const unconfirmedRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await api.get<Partial<Overview>>(BASE);
      setOverview(Array.isArray(next.servers) && Array.isArray(next.spaces)
        ? { servers: next.servers, spaces: next.spaces }
        : "unavailable");
    } catch (cause) {
      if (cause instanceof ApiError && UNAVAILABLE.has(cause.status)) {
        setOverview("unavailable");
        return;
      }
      setOverview((previous) => previous ?? { servers: [], spaces: [] });
      setError({ text: errorText(cause) });
    }
  }, [api]);
  useEffect(() => { void reload(); }, [reload]);

  const cancelAttempt = useCallback(
    (attemptId: string) => api.post(`${BASE}/pair/cancel`, { attemptId }).catch(() => {}),
    [api],
  );

  useEffect(() => () => {
    runRef.current++;
    if (unconfirmedRef.current) void cancelAttempt(unconfirmedRef.current);
    unconfirmedRef.current = null;
  }, [cancelAttempt]);

  const ready = overview !== null && overview !== "unavailable";
  useEffect(() => {
    const target = settingsTarget;
    if (!ready || target?.sectionId !== "join" || handledTargets.has(target)) return;
    const input = formRef.current?.querySelector<HTMLInputElement>("input[name='pairing-link']");
    if (!input) return;
    handledTargets.add(target);
    formRef.current?.closest("section")?.scrollIntoView?.({ block: "start" });
    input.focus({ preventScroll: true });
  }, [settingsTarget, ready]);

  const fail = (cause: unknown) => {
    unconfirmedRef.current = null;
    setFlow(null);
    setError({ text: errorText(cause), title: t("tunnel.joined.joinFailed") });
  };

  /** The host's Space switcher re-reads the list (apps/web/src/spaces.ts). */
  const spacesChanged = () => {
    if (typeof window !== "undefined" && typeof window.CustomEvent === "function") window.dispatchEvent(new window.CustomEvent("polyth:spaces-changed"));
  };

  const confirm = async (pending: Flow & { attemptId: string }) => {
    const run = runRef.current;
    unconfirmedRef.current = null;
    setFlow({ ...pending, stage: "waiting" });
    try {
      const result = await api.post<{ server: JoinedServer; spaces: JoinedSpaceDto[] }>(
        `${BASE}/pair/confirm`,
        { attemptId: pending.attemptId },
      );
      // The other server may have approved just as the person gave up.
      if (run !== runRef.current) {
        await reload();
        return;
      }
      const id = result.server.connectionId;
      spacesChanged();
      setOverview((previous) => {
        const base = previous && previous !== "unavailable" ? previous : { servers: [], spaces: [] };
        return {
          servers: [...base.servers.filter((server) => server.connectionId !== id), result.server],
          spaces: [...base.spaces.filter((space) => space.connectionId !== id), ...result.spaces],
        };
      });
      setFlow(null);
      setLink("");
      setJoined(result.server.label);
    } catch (cause) {
      if (run === runRef.current) fail(cause);
    }
  };

  const join = async () => {
    const typed = link.trim();
    const ticket = pairingLinkFromText(typed) ?? typed;
    if (!ticket || flow) return;
    const run = ++runRef.current;
    setError(null);
    setJoined("");
    setFlow({ stage: "reading" });
    try {
      const preview = await api.post<Preview>(`${BASE}/pair/parse`, { ticket });
      if (run !== runRef.current) return;
      setFlow({ stage: "reading", preview });
      const begun = await api.post<{ attemptId: string; safetyPhrase?: string[] }>(`${BASE}/pair/begin`, { ticket });
      if (run !== runRef.current) {
        await cancelAttempt(begun.attemptId);
        return;
      }
      const invitation = preview.invitation === true;
      const words = invitation ? [] : begun.safetyPhrase ?? [];
      const pending = { stage: "words" as const, preview, attemptId: begun.attemptId, words, invitation };
      // Live pairing with no words has nothing to ask. An invitation always
      // gets one confirmation of the host, without words to compare.
      if (!invitation && words.length === 0) {
        await confirm(pending);
        return;
      }
      unconfirmedRef.current = begun.attemptId;
      setFlow(pending);
    } catch (cause) {
      if (run === runRef.current) fail(cause);
    }
  };

  const cancel = () => {
    runRef.current++;
    unconfirmedRef.current = null;
    if (flow?.attemptId) void cancelAttempt(flow.attemptId);
    setFlow(null);
  };

  const rename = async (connectionId: string, label: string) => {
    const { server } = await api.patch<{ server: JoinedServer }>(`${BASE}/${connectionId}`, { label });
    spacesChanged();
    setJoined("");
    setOverview((previous) => previous && previous !== "unavailable"
      ? { ...previous, servers: previous.servers.map((entry) => entry.connectionId === connectionId ? server : entry) }
      : previous);
  };

  const activeSpaceId = async (): Promise<string | null> => {
    try {
      const spaces = await api.get<{ activeSpaceId?: unknown }>("/api/spaces");
      return typeof spaces.activeSpaceId === "string" ? spaces.activeSpaceId : null;
    } catch {
      return null;
    }
  };

  const leave = async (server: JoinedServer, spaces: JoinedSpaceDto[]) => {
    if (!await confirmAlert(t("tunnel.joined.leaveConfirm", { server: server.label }), {
      title: t("tunnel.joined.leaveTitle", { server: server.label }),
      confirmLabel: t("tunnel.joined.leave"),
    })) return;
    setLeaving(server.connectionId);
    setError(null);
    setJoined("");
    try {
      const before = await activeSpaceId();
      await api.delete(`${BASE}/${server.connectionId}`);
      const wasThere = spaces.some((space) => space.id === before);
      const movedHome = wasThere && await activeSpaceId() !== before;
      spacesChanged();
      await reload();
      if (movedHome) {
        await confirmAlert(t("tunnel.joined.backBody", { server: server.label }), {
          title: t("tunnel.joined.backTitle"),
          confirmLabel: t("tunnel.joined.ok"),
          destructive: false,
        });
        // Everything on screen still belongs to the Space that is gone.
        location.reload();
      }
    } catch (cause) {
      setError({ text: errorText(cause), title: t("tunnel.joined.leaveFailed", { server: server.label }) });
    } finally {
      setLeaving("");
    }
  };

  if (!overview || overview === "unavailable") return null;
  const serverName = flow?.preview?.hostLabel ?? "";

  return (
    <>
      <Section title={t("tunnel.joined.title")} hint={t("tunnel.joined.hint")} itemId="tunnel.join">
        <form
          ref={formRef}
          className="pkg-tunnel-join"
          onSubmit={(event) => {
            event.preventDefault();
            void join();
          }}
        >
          <label htmlFor={inputId}>{t("tunnel.joined.linkLabel")}</label>
          <div className="pkg-tunnel-join-row">
            <TextInput
              id={inputId}
              name="pairing-link"
              value={link}
              placeholder="polyth://pair?…"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => {
                setLink(event.target.value);
                setError(null);
              }}
            />
            <Button variant="primary" type="submit" disabled={!link.trim() || flow !== null}>
              {t("tunnel.joined.join")}
            </Button>
          </div>
          <p className="pkg-tunnel-meta">{t("tunnel.joined.linkHint")}</p>
        </form>
        {error && <ErrorState compact title={error.title} error={error.text} />}
        {joined && <p className="pkg-tunnel-for-notice pkg-tunnel-joined-done" role="status">{t("tunnel.joined.success", { server: joined })}</p>}
        {overview.servers.length > 0 && (
          <ul className="pkg-tunnel-devices">
            {overview.servers.map((server) => {
              const spaces = overview.spaces.filter((space) => space.connectionId === server.connectionId);
              return (
                <ServerRow
                  key={server.connectionId}
                  server={server}
                  spaces={spaces}
                  leaving={leaving === server.connectionId}
                  onRename={(label) => rename(server.connectionId, label)}
                  onLeave={() => void leave(server, spaces)}
                  t={t}
                />
              );
            })}
          </ul>
        )}
      </Section>

      {flow && (
        <Dialog
          title={serverName ? t("tunnel.joined.dialogTitle", { server: serverName }) : t("tunnel.joined.dialogTitleUnnamed")}
          size="sm"
          className="pkg-tunnel-dialog"
          onClose={cancel}
          footer={(
            <>
              <Button onClick={cancel}>{t("tunnel.dialog.cancel")}</Button>
              {flow.stage === "words" && flow.attemptId && (
                <Button variant="primary" onClick={() => void confirm({ ...flow, attemptId: flow.attemptId! })}>
                  {t(flow.invitation ? "tunnel.joined.join" : "tunnel.joined.wordsMatch")}
                </Button>
              )}
            </>
          )}
        >
          <div className="pkg-tunnel-pair">
            {flow.words && flow.words.length > 0 && (
              <ol className="pkg-tunnel-phrase">
                {flow.words.map((word, index) => <li key={`${index}-${word}`} dir="auto">{word}</li>)}
              </ol>
            )}
            {flow.stage === "words" && !flow.invitation && <p className="pkg-tunnel-lead">{t("tunnel.joined.checkWords")}</p>}
            {flow.stage !== "words" && (
              <div className="pkg-tunnel-join-progress" role="status">
                <Spinner />
                <span>
                  {flow.stage === "waiting"
                    ? t("tunnel.joined.waiting", { server: serverName })
                    : t("tunnel.joined.connecting")}
                </span>
              </div>
            )}
            {flow.preview?.fingerprint && (
              <p className="pkg-tunnel-meta pkg-tunnel-join-fingerprint">
                {t("tunnel.joined.fingerprint", { fingerprint: flow.preview.fingerprint })}
              </p>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
