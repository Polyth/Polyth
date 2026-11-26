// A page shown full size outside a chat: the same sandboxed frame, policy and
// bridge as the ```page block, filling whatever holds it. The holder owns
// everything around the frame and decides whether `polyth.storage` lasts: it
// passes the map a load starts with and hears every change the page makes.
//
// The frame grants a page nothing a chat block does not: scripts only, no
// network, no same-origin, and `polyth.send` goes nowhere here.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { buildPageDocument, parsePageMessage, type PageMessage } from "../src/page.ts";
import { MAX_RESETS, PageIframe, docsOf, readPageTheme, usePageThemePush } from "./pageFrame.tsx";

export type PageStorageChange = Extract<PageMessage, { kind: "storage" }>;

export interface PageSurfaceProps {
  html: string;
  /** The frame's accessible name. */
  title: string;
  /** Read once per load (and again after a reset), so a page that was put
   *  back on its own document starts from what it last stored. */
  storage(): Readonly<Record<string, string>>;
  /** True when the holder keeps the map; the page reads it as
   *  `polyth.storage.persistent`. */
  persistent: boolean;
  onStorage(change: PageStorageChange): void;
  /** Shown in place of the frame when the page kept leaving its document. */
  stopped: ReactNode;
  className?: string;
}

const FRAME_STYLE = { display: "block", inlineSize: "100%", blockSize: "100%", border: 0, background: "var(--bg)", colorScheme: "normal" } as const;

export default function PageSurface({ html, title, storage, persistent, onStorage, stopped, className }: PageSurfaceProps): ReactNode {
  const [generation, setGeneration] = useState(0);
  const frames = useRef(new Set<HTMLIFrameElement>());
  const onStorageRef = useRef(onStorage);
  onStorageRef.current = onStorage;
  const storageRef = useRef(storage);
  storageRef.current = storage;

  // One document per (page, load): a new page or a reset rebuilds it, a
  // re-render does not, so the page keeps running.
  const built = useRef<{ html: string; generation: number; persistent: boolean; doc: string } | null>(null);
  if (!built.current || built.current.html !== html || built.current.generation !== generation || built.current.persistent !== persistent) {
    built.current = { html, generation, persistent, doc: buildPageDocument(html, readPageTheme(), { storage: storageRef.current(), persistent }) };
  }

  useEffect(() => { setGeneration(0); }, [html]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      let from: HTMLIFrameElement | null = null;
      for (const frame of frames.current) if (frame.contentWindow !== null && frame.contentWindow === event.source) from = frame;
      if (!from) return;
      const message = parsePageMessage(event.data);
      if (!message) return;
      if (message.kind === "ready") { docsOf(from).readies += 1; return; }
      if (message.kind === "storage") onStorageRef.current(message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  usePageThemePush(frames);

  const register = useCallback((node: HTMLIFrameElement | null, previous: { current: HTMLIFrameElement | null }) => {
    if (previous.current) frames.current.delete(previous.current);
    previous.current = node;
    if (node) frames.current.add(node);
  }, []);
  const navigated = useCallback(() => setGeneration((value) => value + 1), []);

  if (generation >= MAX_RESETS) return stopped;
  return (
    <PageIframe
      key={generation}
      srcDoc={built.current.doc}
      title={title}
      register={register}
      onNavigated={navigated}
      full
      style={FRAME_STYLE}
      className={className ?? ""}
    />
  );
}
