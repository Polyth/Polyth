// Hover copy button for pre / diff / code blocks (UX-38).
import { useState } from "react";
import { copyText } from "../utils.ts";
import { tr } from "../i18n/index.ts";
import { CopiedIcon, CopyIcon, IconButton } from "./ui/index.ts";

export default function CopyButton({ text, label = tr("copybutton.copyToClipboard") }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const actionLabel = done ? "Copied" : label;
  return (
    <IconButton
      icon={done ? CopiedIcon : CopyIcon}
      label={actionLabel}
      size="sm"
      className="copy-btn"
      title={actionLabel}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text).then((ok) => {
          if (!ok) return;
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    />
  );
}
