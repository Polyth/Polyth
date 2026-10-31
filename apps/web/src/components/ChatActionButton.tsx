import type { IconButtonProps } from "./ui/index.ts";
import { IconButton, Tooltip } from "./ui/index.ts";
import "./ChatChrome.css";

export type ChatActionButtonProps = Omit<IconButtonProps, "size" | "variant" | "title">;

/** One visual language for message and response actions: canonical Lucide
 * glyphs, compact visual geometry, and the shared coarse-pointer hit seam. */
export default function ChatActionButton({ className, label, ...props }: ChatActionButtonProps) {
  return (
    <Tooltip content={label} className="chat-action-tooltip">
      <IconButton
        {...props}
        label={label}
        size="sm"
        variant="ghost"
        title=""
        className={["chat-action-button", className ?? ""].filter(Boolean).join(" ")}
      />
    </Tooltip>
  );
}
