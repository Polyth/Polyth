// Message quick action: open links found in a message in the Browser pane.
// Contributed through `session.message.actions`; the host owns placement,
// ordering and visibility. Rendering nothing when a message has no links
// keeps the action bar quiet. In the message's "More" menu the host keeps this
// mounted without a trigger: a selection request opens the link list (or the
// only link) anchored to the action bar.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { api } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { setUiError, workspacePresentationKey } from "../../../apps/web/src/store.ts";
import ChatActionButton from "../../../apps/web/src/components/ChatActionButton.tsx";
import { ExternalLinkIcon, Menu, PullRequestIcon, type MenuEntry, type MenuTriggerProps } from "../../../apps/web/src/components/ui/index.ts";
import { recalledBrowserTab, rememberBrowserTab } from "./browserTabs.ts";
import { extractMessageLinks, pullRequestLabel, type MessageLink } from "./messageLinks.ts";
import { openUrlInBrowser, type OpenInBrowserDeps } from "./openInBrowser.ts";
import { appAppearance } from "./appAppearance.ts";

export function messageTextOf(context: Readonly<Record<string, unknown>>): string {
  return typeof context.messageText === "string" ? context.messageText : "";
}

export function messageHasLinks(context: Readonly<Record<string, unknown>>): boolean {
  return extractMessageLinks(messageTextOf(context), 1).length > 0;
}

/** Menu entries: pull/merge requests read as "owner/repo #42" with their host
 *  as detail; other links show their compact host + path. */
export function messageLinkEntries(links: readonly MessageLink[], open: (url: string) => void): MenuEntry[] {
  return links.map((link) => {
    const pr = pullRequestLabel(link);
    return {
      id: link.url,
      label: pr ?? link.label,
      icon: pr ? PullRequestIcon : ExternalLinkIcon,
      ...(pr ? { detail: `${tr("browser.links.pullRequest")} · ${link.host}` } : {}),
      onSelect: () => { open(link.url); },
    };
  });
}

/** Points Menu's trigger ref at the host's action bar while the entry has no
 *  visible button of its own ("More" menu placement). */
function BorrowedAnchor({ target, anchor }: { target: MenuTriggerProps["ref"]; anchor: () => HTMLElement | null }) {
  useLayoutEffect(() => {
    if (target && typeof target === "object") (target as RefObject<HTMLElement | null>).current = anchor();
  });
  return null;
}

export default function MessageLinksAction({
  text, projectId, sessionId, openPane, messageActionPlacement, messageActionRequest, messageActionAnchor, deps,
}: {
  text: string;
  projectId: string | null;
  sessionId: string | null;
  openPane: () => void;
  messageActionPlacement?: unknown;
  messageActionRequest?: unknown;
  messageActionAnchor?: unknown;
  /** Test seam; defaults to the Browser web API. */
  deps?: Partial<OpenInBrowserDeps>;
}) {
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const inMenu = messageActionPlacement === "menu";
  const request = typeof messageActionRequest === "number" ? messageActionRequest : 0;
  const anchor = typeof messageActionAnchor === "function" ? messageActionAnchor as () => HTMLElement | null : () => null;
  const seenRequest = useRef(request);
  const links = extractMessageLinks(text);

  const open = async (url: string) => {
    if (!projectId) return;
    const presentationKey = workspacePresentationKey("browser.tab", projectId, sessionId);
    setBusy(true);
    try {
      await openUrlInBrowser({ projectId, sessionId }, url, {
        list: (id) => api.browserList(id),
        create: (input) => api.browserCreate(input),
        navigate: (id, target) => api.browserNavigate(id, target, "user"),
        recalledTab: () => recalledBrowserTab(presentationKey),
        rememberTab: (id) => rememberBrowserTab(presentationKey, id),
        openPane,
        appearance: appAppearance,
        ...deps,
      });
    } catch (cause) {
      // The host's single transient error surface (design-system §10); a
      // policy refusal carries the server's reason. Nothing is retried.
      setUiError(friendlyError(tr("browser.links.failed"), cause));
    } finally {
      setBusy(false);
    }
  };

  // "More" menu selection: one link opens directly, several open the list.
  useEffect(() => {
    if (request === seenRequest.current) return;
    seenRequest.current = request;
    if (!inMenu || links.length === 0) return;
    if (links.length === 1) void open(links[0]!.url);
    else setMenuOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (!projectId || links.length === 0) return null;
  const entries = messageLinkEntries(links, (url) => { void open(url); });
  const label = tr("browser.links.openInBrowser");
  return (
    <Menu
      label={tr("browser.links.menuLabel")}
      entries={entries}
      align="start"
      phonePresentation={inMenu ? "sheet" : "popover"}
      {...(inMenu ? { open: menuOpen, onOpenChange: setMenuOpen } : {})}
    >
      {(trigger) => inMenu
        ? <BorrowedAnchor target={trigger.ref} anchor={anchor} />
        : <ChatActionButton {...trigger} icon={ExternalLinkIcon} label={label} busy={busy} data-action-id="browser.message-links" />}
    </Menu>
  );
}
