// The glyph of one action step (a command, a file read, a search, an MCP
// call...). Shared by the chat's action rows and live line, and by package
// views that present an agent's steps the same way (an agent's live turn).
import type { ExecutionKind } from "../execution.ts";
import type { McpIcon } from "../toolCallView.ts";
import { Icon } from "../icons.tsx";
import { McpGlyph } from "./ToolCallDetail.tsx";

export function ExecutionIcon({ kind, image = false, mcp }: { kind: ExecutionKind; image?: boolean; mcp?: McpIcon }) {
  if (mcp) return <McpGlyph icon={mcp} />;
  const Glyph = image ? Icon.image
    : kind === "shell" ? Icon.term
    : kind === "read" ? Icon.files
      : kind === "edit" || kind === "write" ? Icon.fileEdit
        : kind === "create" ? Icon.plus
          : kind === "delete" ? Icon.trash
            : kind === "move" ? Icon.branch
              : kind === "search" ? Icon.search
                : kind === "web" || kind === "browser" ? Icon.globe
                  : kind === "mcp" ? Icon.plug
                    : kind === "subagent" ? Icon.hierarchy
                      : kind === "test" ? Icon.check
                        : kind === "git" ? Icon.branch
                          : Icon.events;
  return <Glyph />;
}
