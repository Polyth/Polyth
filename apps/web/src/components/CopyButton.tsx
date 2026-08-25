// Hover copy button for pre / diff / code blocks (UX-38).
import { useState } from "react";
import { copyText } from "../utils.ts";
import { Icon } from "../icons.tsx";
import { tr } from "../i18n/index.ts";

export default function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy-btn"
      title={tr("copybutton.copyToClipboard")}
      aria-label={tr("copybutton.copyToClipboard")}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text).then((ok) => {
          if (!ok) return;
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      <span aria-hidden="true">{done ? <Icon.check /> : <Icon.copy />}</span>
    </button>
  );
}
