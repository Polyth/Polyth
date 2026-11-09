// Bookmarks web entry: the button under an answer, the whole list as a workspace
// surface, and the line above the composer that walks from one place to the next.
// Everything reaches the shell through generic seams, so a disabled or removed
// package leaves the chat exactly as it was.
import "./styles.css";
import { createElement } from "react";
import { defineWebPackage, type MessageActionSlotMeta, type PromptTabSlotMeta, type SelectionActionSlotMeta } from "@polyth/web-sdk";
import { BookmarkIcon } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { BOOKMARK_LIMITS } from "../src/bookmarks.ts";
import BookmarkAction, { answerActionAvailable, answerActionMenuLabel } from "./BookmarkAction.tsx";
import BookmarksPanel from "./BookmarksPanel.tsx";
import { connectBookmarks, getSessionBookmarks, subscribeBookmarks } from "./client.ts";
import { openBookmarksPane, saveWithUndo } from "./commands.ts";
import { BOOKMARKS_SURFACE_ID } from "./ids.ts";
import { PeekBookmarks, PeekLinks } from "./PeekTabs.tsx";
import WalkBar from "./WalkBar.tsx";

export default defineWebPackage((host) => () => {
  const disconnect = connectBookmarks(host);
  const off = [
    host.surfaces.register({
      id: BOOKMARKS_SURFACE_ID,
      title: tr("bookmarks.surface.title"),
      description: tr("bookmarks.surface.description"),
      capabilityId: BOOKMARKS_SURFACE_ID,
      order: 42,
      component: (props) => createElement(BookmarksPanel, { host, ...props }),
      presentation: { kind: "workspace", defaultRatio: 0.36, minWidth: 300, preferredMaxWidth: 560, keepAlive: true, escape: "close" },
    }),
    host.capabilities.register({
      id: BOOKMARKS_SURFACE_ID,
      label: tr("bookmarks.surface.title"),
      plainDescription: tr("bookmarks.capability.description"),
      keywords: ["bookmark", "bookmarks", "notes", "notebook", "links", "saved", "pin"],
      icon: BookmarkIcon,
      standardTier: "more",
      standardRank: 19,
      // The way in while the chat's own bookmark icon is off, as a Workspace tile.
      defaultRails: {
        general: "right",
        engineering: "right",
        research: "right",
        operations: "right",
        home: "right",
        wellbeing: "right",
        finance: "right",
        personal: "right",
      },
      open: () => { openBookmarksPane(host); },
      available: () => true,
    }),
    host.slots.register({
      slot: "session.message.actions",
      id: "bookmarks.toggle",
      order: 45,
      render: (context) => createElement(BookmarkAction, { host, context }),
      meta: {
        messageAction: {
          label: () => tr("bookmarks.action.label"),
          menuLabel: answerActionMenuLabel,
          description: () => tr("bookmarks.action.description"),
          icon: BookmarkIcon,
          roles: ["assistant"],
          menu: true,
          available: answerActionAvailable,
        } satisfies MessageActionSlotMeta,
      },
    }),
    host.slots.register({
      slot: "session.selection.actions",
      id: "bookmarks.selection",
      order: 10,
      render: () => null,
      meta: {
        selectionAction: {
          label: () => tr("bookmarks.action.add"),
          title: () => tr("bookmarks.selection.title"),
          icon: BookmarkIcon,
          available: (context) => Boolean(context.sessionId) && context.eventSeq !== null,
          run: async (context) => {
            await saveWithUndo(host, {
              kind: "fragment",
              sessionId: context.sessionId!,
              eventSeq: context.eventSeq!,
              body: context.markdown,
              quote: context.text.slice(0, BOOKMARK_LIMITS.quoteChars),
            });
          },
        } satisfies SelectionActionSlotMeta,
      },
    }),
    host.slots.register({
      slot: "session.prompt.tabs",
      id: "bookmarks.list",
      order: 10,
      render: (context) => createElement(PeekBookmarks, { host, context }),
      meta: {
        promptTab: {
          label: () => tr("bookmarks.tab.bookmarks"),
          hasContent: (sessionId) => getSessionBookmarks(sessionId).length > 0,
          subscribe: subscribeBookmarks,
        } satisfies PromptTabSlotMeta,
      },
    }),
    host.slots.register({
      slot: "session.prompt.tabs",
      id: "bookmarks.links",
      order: 20,
      render: (context) => createElement(PeekLinks, { context }),
      meta: {
        promptTab: {
          label: () => tr("bookmarks.tab.links"),
          hasContent: (sessionId) => getSessionBookmarks(sessionId).some((bookmark) => bookmark.links.length > 0),
          subscribe: subscribeBookmarks,
        } satisfies PromptTabSlotMeta,
      },
    }),
    host.slots.register({
      slot: "session.composer.before",
      id: "bookmarks.walk",
      order: 880,
      meta: { title: tr("bookmarks.walk.label") },
      render: (props) => createElement(WalkBar, { host, sessionId: typeof props.sessionId === "string" ? props.sessionId : null }),
    }),
  ];
  return () => {
    for (const dispose of off.toReversed()) dispose();
    disconnect();
  };
});
