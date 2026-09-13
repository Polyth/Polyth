import type { IconButtonProps } from "./ui/index.ts";
import { IconButton, Tooltip } from "./ui/index.ts";

export type ChatActionButtonProps = Omit<IconButtonProps, "size" | "variant" | "title">;

/** One action language for message and response chrome. */
export default function ChatActionButton({ className, label, ...props }: ChatActionButtonProps) {
  return (
    <Tooltip content={label} className="chat-action-tooltip">
      <IconButton
        {...props}
        label={label}
        size="md"
        variant="ghost"
        title=""
        className={["chat-action-button", className ?? ""].filter(Boolean).join(" ")}
      />
    </Tooltip>
  );
}
