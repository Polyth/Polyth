import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { StudioScene } from "../src/index.ts";
import { CloseGlyph, SendGlyph } from "./glyphs.tsx";
import { fill, type StudioStrings } from "./strings.ts";

export type DockOutcome = "sent" | "queued" | false;

interface Props {
  host: WebPackageHost;
  t: StudioStrings;
  working: boolean;
  scope: { scene: StudioScene; index: number } | null;
  /** Bumped to move focus into the field ("Ask for changes", "Change"). */
  focusRequest: number;
  onClearScope(): void;
  onSend(text: string): Promise<DockOutcome>;
}

/** The studio's one way to talk to the agent: a request, optionally about one
 * scene. While the agent works the message waits for its current step. */
export default function Dock({ host, t, working, scope, focusRequest, onClearScope, onSend }: Props) {
  const { IconButton, Textarea } = host.ui.components;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (focusRequest > 0) field.current?.focus({ preventScroll: true });
  }, [focusRequest]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      const outcome = await onSend(value);
      if (outcome) {
        setText("");
        setNotice({ tone: "ok", text: outcome === "queued" ? t.dockQueued : t.dockSent });
      } else {
        setNotice({ tone: "error", text: t.dockFailed });
      }
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends with a keyboard; touch keyboards keep Enter for new lines.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) return;
    event.preventDefault();
    void submit();
  };

  const placeholder = scope ? fill(t.dockPlaceholderScene, { title: scope.scene.title }) : working ? t.dockPlaceholderWorking : t.dockPlaceholder;
  return (
    <form className="cs-dock" onSubmit={submit} aria-label={t.dockLabel}>
      {notice && <p className={notice.tone === "error" ? "cs-dock-notice cs-dock-notice--error" : "cs-dock-notice"} role="status">{notice.text}</p>}
      <div className="cs-dock-bar ui-glass-dock ui-field-frame">
        {scope && (
          <span className="cs-dock-scope">
            <b>{scope.index + 1}</b>
            <span>{scope.scene.title}</span>
            <button type="button" aria-label={t.dockClearScope} title={t.dockClearScope} onClick={onClearScope}><CloseGlyph /></button>
          </span>
        )}
        <Textarea
          ref={field}
          className="cs-dock-input"
          autoGrow
          minRows={1}
          maxRows={5}
          value={text}
          placeholder={placeholder}
          aria-label={t.dockLabel}
          dir="auto"
          enterKeyHint="send"
          onChange={(event: { target: { value: string } }) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <IconButton
          type="submit"
          className="cs-dock-send"
          icon={SendGlyph}
          label={t.dockSend}
          variant="quiet"
          size="md"
          busy={sending}
          disabled={!text.trim()}
        />
      </div>
    </form>
  );
}
